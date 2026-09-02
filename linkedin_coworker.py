"""
BizDev Coworker
===============

WHAT THIS APP DOES
-------------------
This app does NOT log into LinkedIn or scrape it. LinkedIn's Terms of
Service prohibit automated login and scraping, and doing so risks getting
a user's account suspended. Instead, this app works with data you already
have a legitimate right to:

1. You export your own connections from LinkedIn yourself:
   Settings & Privacy -> Data Privacy -> "Get a copy of your data" ->
   select "Connections" -> Request archive. LinkedIn emails you a
   Connections.csv file (Name, Company, Position, Email if public, and
   the date you connected).
2. You upload that CSV here.
3. You tell the app what topic you want to talk about.
4. The app (using an LLM) ranks your connections by how likely they are
   to care about that topic, based on their title/company.
5. For your top matches, it drafts a personalized outreach message.
6. You copy the message and send it yourself via LinkedIn (or email, if
   you have their email address) -- this app never sends anything on
   your behalf automatically.

SETUP (local)
-------------
pip install -r requirements.txt
python -m streamlit run linkedin_coworker.py --server.port 8502

STREAMLIT COMMUNITY CLOUD
-------------------------
1. Push this repo to GitHub.
2. At share.streamlit.io, deploy linkedin_coworker.py from the repo.
3. In App settings -> Secrets, add:
   openai_api_key = "sk-..."
"""

import html
import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd
import streamlit as st
from openai import OpenAI

DATA_DIR = Path(__file__).resolve().parent / "data"
PERSIST_PATH = DATA_DIR / "top10.json"
SETTINGS_PATH = DATA_DIR / "settings.json"
SETTING_KEYS = ("openai_api_key", "user_name", "user_headline", "match_count", "dark_mode")

st.set_page_config(page_title="BizDev Coworker", page_icon="🤝", layout="wide")

st.markdown(
    """
    <style>
    .block-container { padding-top: 1.2rem; padding-bottom: 1rem; }
    .email-chrome {
        border: 1px solid #d0d5dd;
        border-radius: 10px;
        overflow: hidden;
        font-family: "Segoe UI", Arial, sans-serif;
        margin-bottom: 0.75rem;
    }
    .email-chrome .hdr {
        background: #f8fafc;
        padding: 12px 14px;
        border-bottom: 1px solid #e5e7eb;
        font-size: 0.92rem;
        line-height: 1.55;
        color: #111827;
    }
    .email-chrome .row { display: flex; gap: 8px; }
    .email-chrome .lbl { color: #667085; min-width: 64px; font-weight: 600; }
    .match-meta { color: #475467; font-size: 0.9rem; margin: 0; }
    [data-testid="stTextArea"] textarea {
        white-space: pre-wrap !important;
        overflow-wrap: anywhere;
        word-break: break-word;
        resize: vertical !important;
        line-height: 1.4;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

# ----------------------------------------------------------------------------
# Session state
# ----------------------------------------------------------------------------
defaults = {
    "openai_api_key": "",
    "user_name": "",
    "user_headline": "",
    "match_count": 10,
    "dark_mode": False,
    "connections_df": None,
    "ranked": None,
    "ranked_topic": "",
    "ranked_saved_at": "",
    "drafts": {},
    "settings_hydrated": False,
}
for k, v in defaults.items():
    if k not in st.session_state:
        st.session_state[k] = v


def is_streamlit_cloud():
    """Community Cloud uses a shared, ephemeral filesystem — do not persist user data there."""
    return (
        Path("/mount/src").exists()
        or os.getenv("STREAMLIT_RUNTIME_ENV") == "cloud"
        or os.getenv("USER") == "appuser"
    )


def persist_to_disk():
    return not is_streamlit_cloud()


def normalize_match_count(value, fallback=10):
    try:
        n = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(1, min(100, n))


def secret_api_key():
    try:
        return str(st.secrets.get("openai_api_key") or "").strip()
    except Exception:
        return ""


def get_api_key():
    return (st.session_state.get("openai_api_key") or "").strip() or secret_api_key()


def get_client():
    key = get_api_key()
    if not key:
        return None
    return OpenAI(api_key=key)


def _json_default(o):
    if hasattr(o, "item"):
        return o.item()
    return str(o)


def drafts_for_json(drafts):
    return {str(k): v for k, v in drafts.items()}


def drafts_from_json(raw):
    out = {}
    for k, v in (raw or {}).items():
        try:
            key = int(k)
        except (TypeError, ValueError):
            key = k
        out[key] = v
    return out


def load_settings():
    if not persist_to_disk() or not SETTINGS_PATH.exists():
        return False
    try:
        payload = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return False
    for key in SETTING_KEYS:
        if key not in payload:
            continue
        value = payload.get(key)
        if key == "match_count":
            st.session_state[key] = normalize_match_count(value)
        elif key == "dark_mode":
            st.session_state[key] = bool(value)
        elif isinstance(value, str):
            st.session_state[key] = value
    return True


def save_settings():
    if not persist_to_disk():
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {}
    for key in SETTING_KEYS:
        if key == "match_count":
            payload[key] = normalize_match_count(st.session_state.get(key, 10))
        elif key == "dark_mode":
            payload[key] = bool(st.session_state.get(key, False))
        else:
            payload[key] = st.session_state.get(key, "") or ""
    SETTINGS_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def load_persisted_top10():
    if not persist_to_disk() or not PERSIST_PATH.exists():
        return False
    try:
        payload = json.loads(PERSIST_PATH.read_text(encoding="utf-8"))
    except Exception:
        return False
    ranked = payload.get("ranked")
    if not ranked:
        return False
    st.session_state.ranked = ranked
    st.session_state.ranked_topic = payload.get("ranked_topic") or ""
    st.session_state.ranked_saved_at = payload.get("saved_at") or ""
    st.session_state.drafts = drafts_from_json(payload.get("drafts"))
    if st.session_state.ranked_topic and "topic" not in st.session_state:
        st.session_state.topic = st.session_state.ranked_topic
    return True


if not st.session_state.settings_hydrated:
    load_settings()
    if not st.session_state.openai_api_key and secret_api_key():
        st.session_state.openai_api_key = secret_api_key()
    st.session_state.settings_hydrated = True

if not st.session_state.ranked:
    load_persisted_top10()

if st.session_state.get("dark_mode"):
    st.markdown(
        """
        <style>
        .stApp, [data-testid="stAppViewContainer"], [data-testid="stHeader"] {
            background-color: #0f1419 !important;
            color: #e8eef5 !important;
        }
        [data-testid="stHeader"] { background: rgba(15, 20, 25, 0.9) !important; }
        [data-testid="stSidebar"] {
            background-color: #1a222c !important;
            color: #e8eef5 !important;
        }
        [data-testid="stSidebar"] * { color: #e8eef5; }
        .stMarkdown, .stCaption, p, h1, h2, h3, label { color: #e8eef5 !important; }
        .stTextInput input, .stTextArea textarea, .stNumberInput input,
        [data-baseweb="input"] input, [data-baseweb="textarea"] textarea {
            background-color: #12181f !important;
            color: #e8eef5 !important;
            caret-color: #e8eef5 !important;
        }
        [data-testid="stFileUploader"] { color: #e8eef5 !important; }
        .email-chrome { border-color: #3d4d5c !important; }
        .email-chrome .hdr {
            background: #12181f !important;
            border-bottom-color: #2c3947 !important;
            color: #e8eef5 !important;
        }
        .match-meta { color: #b6c2d0 !important; }
        div[data-testid="stMetricValue"] { color: #e8eef5 !important; }
        </style>
        """,
        unsafe_allow_html=True,
    )


def parse_draft_payload(text, topic):
    cleaned = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    try:
        data = json.loads(cleaned)
        return {
            "subject": str(data.get("subject") or topic).strip(),
            "body": str(data.get("body") or "").strip(),
        }
    except Exception:
        return {"subject": topic[:90], "body": text.strip()}


def email_to_line(person):
    name = person.get("name") or "Unknown"
    email = (person.get("email") or "").strip()
    if email:
        return f"{name} <{email}>"
    return f"{name} (via LinkedIn)"


def current_draft(person_id):
    sub_key = f"dlg_subject_{person_id}"
    body_key = f"dlg_body_{person_id}"
    if sub_key in st.session_state:
        return {
            "subject": st.session_state[sub_key],
            "body": st.session_state.get(body_key, ""),
        }
    draft = st.session_state.drafts.get(person_id, {})
    if isinstance(draft, str):
        return {"subject": "", "body": draft}
    return {"subject": draft.get("subject", ""), "body": draft.get("body", "")}


def save_top10():
    if not st.session_state.ranked:
        return
    drafts = {}
    for person in st.session_state.ranked:
        pid = person["id"]
        draft = current_draft(pid)
        if draft.get("subject") or draft.get("body"):
            drafts[pid] = draft
        elif pid in st.session_state.drafts:
            drafts[pid] = st.session_state.drafts[pid]
    st.session_state.drafts = drafts
    st.session_state.ranked_saved_at = datetime.now(timezone.utc).isoformat()
    if not persist_to_disk():
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "saved_at": st.session_state.ranked_saved_at,
        "ranked_topic": st.session_state.ranked_topic,
        "ranked": st.session_state.ranked,
        "drafts": drafts_for_json(drafts),
    }
    PERSIST_PATH.write_text(
        json.dumps(payload, indent=2, default=_json_default),
        encoding="utf-8",
    )


def ranked_export_csv():
    rows = []
    for i, person in enumerate(st.session_state.ranked or [], start=1):
        draft = current_draft(person["id"])
        subject = draft.get("subject", "")
        body = draft.get("body", "")
        rows.append({
            "Rank": i,
            "Name": person.get("name", ""),
            "Position": person.get("position", ""),
            "Company": person.get("company", ""),
            "Email": person.get("email", ""),
            "Score": person.get("score", ""),
            "Reason": person.get("reason", ""),
            "Email Subject": subject,
            "Draft Message": body,
        })
    return pd.DataFrame(rows).to_csv(index=False).encode("utf-8")


def generate_draft(person, topic):
    client = get_client()
    first_name = (person.get("name") or "").split()[0] if person.get("name") else "there"
    msg_prompt = f"""Write a short, warm, non-salesy outreach email from \
{st.session_state.user_name or "me"} ({st.session_state.user_headline or ""}) to {person['name']}, \
who works as {person['position']} at {person['company']}.

The message should introduce this topic and gauge interest, referencing why it's \
relevant to their company and role: "{topic}"

Keep the body under 80 words, greet with first name only ({first_name}), conversational tone, \
one clear soft call to action (e.g. "worth a quick chat?"). No hashtags, no emojis, \
no signature block.

Respond with ONLY JSON, no other text:
{{"subject": "email subject line, under 70 characters", "body": "email body"}}"""
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": msg_prompt}],
        temperature=0.7,
    )
    return parse_draft_payload(resp.choices[0].message.content, topic)


@st.dialog("Draft message", width="large")
def draft_message_dialog(person):
    topic = st.session_state.ranked_topic or st.session_state.get("topic", "")
    draft_key = person["id"]
    client = get_client()

    if draft_key not in st.session_state.drafts:
        if client is None:
            st.error("Add your OpenAI API key in the sidebar first.")
            return
        with st.spinner("Drafting..."):
            try:
                st.session_state.drafts[draft_key] = generate_draft(person, topic)
                save_top10()
            except Exception as e:
                st.error(f"Couldn't draft this message: {e}")
                return

    draft = st.session_state.drafts[draft_key]
    if isinstance(draft, str):
        draft = {"subject": topic[:90], "body": draft}
        st.session_state.drafts[draft_key] = draft

    from_name = st.session_state.user_name or "Me"
    to_line = email_to_line(person)
    st.markdown(
        f"""
        <div class="email-chrome">
          <div class="hdr">
            <div class="row"><span class="lbl">From</span><span>{html.escape(from_name)}</span></div>
            <div class="row"><span class="lbl">To</span><span>{html.escape(to_line)}</span></div>
          </div>
        </div>
        """,
        unsafe_allow_html=True,
    )
    subject = st.text_input("Subject", value=draft["subject"], key=f"dlg_subject_{draft_key}")
    body = st.text_area("Message", value=draft["body"], height=220, key=f"dlg_body_{draft_key}")

    full_email = (
        f"From: {from_name}\n"
        f"To: {to_line}\n"
        f"Subject: {subject}\n"
        "MIME-Version: 1.0\n"
        "Content-Type: text/plain; charset=utf-8\n\n"
        f"{body}\n"
    )
    st.download_button(
        "Download .eml",
        data=full_email.encode("utf-8"),
        file_name=f"outreach_{(person.get('name') or 'contact').replace(' ', '_')}.eml",
        mime="message/rfc822",
        width="stretch",
    )


def load_connections_csv(uploaded):
    raw = uploaded.read().decode("utf-8", errors="ignore")
    # LinkedIn's export has a few "Notes:" preamble lines before the real header row.
    lines = raw.splitlines()
    header_idx = 0
    for i, line in enumerate(lines):
        if "First Name" in line and "Last Name" in line:
            header_idx = i
            break
    csv_body = "\n".join(lines[header_idx:])
    df = pd.read_csv(io.StringIO(csv_body))
    df.columns = [c.strip() for c in df.columns]
    return df


def rank_connections(df, topic, match_count):
    client = get_client()
    name_cols = [c for c in df.columns if "Name" in c]
    company_col = next((c for c in df.columns if "Company" in c), None)
    position_col = next((c for c in df.columns if "Position" in c), None)
    email_col = next((c for c in df.columns if "Email" in c), None)

    roster = []
    for idx, row in df.iterrows():
        name = " ".join(str(row.get(c, "")) for c in name_cols).strip()
        roster.append({
            "id": int(idx),
            "name": name,
            "company": str(row.get(company_col, "")) if company_col else "",
            "position": str(row.get(position_col, "")) if position_col else "",
        })

    all_scores = {}
    batch_size = 60
    total = len(roster)

    def ranking_status(done):
        left = max(0, total - done)
        return f"{done} of {total} contacts processed, {left} left"

    progress = st.progress(0.0, text=ranking_status(0))
    for start in range(0, total, batch_size):
        batch = roster[start:start + batch_size]
        batch_end = min(start + len(batch), total)
        progress.progress(start / total if total else 1.0, text=ranking_status(start))
        prompt = f"""You are helping {st.session_state.user_name or "a professional"} \
({st.session_state.user_headline or "no headline provided"}) figure out which of \
their LinkedIn connections would most likely be interested in this topic:

TOPIC: "{topic}"

For each connection below (given as id, name, company, position), rate from 0-100 \
how likely they are to want to hear about this topic.

Score using BOTH of these, and weigh company fit heavily:
1. COMPANY MATCH: Infer what the company does from its name (industry, products, \
customers, business model). Does this topic matter to that company — would it \
help, sell to, compete with, or otherwise be relevant to that organization's work? \
A strong company match should score high even if the person's title is only loosely related. \
A poor company match should score low even if the title sounds relevant.
2. ROLE MATCH: Consider job function, seniority, and whether this person would \
plausibly own, influence, or care about the topic.

In "reason", mention the company-topic fit first, then the role if relevant.

Connections:
{json.dumps(batch, indent=2)}

Respond with ONLY a JSON array, no other text, in this exact format:
[{{"id": 0, "score": 87, "reason": "one short phrase why"}}, ...]
One entry per connection given, in any order."""
        try:
            resp = client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
            )
            text = resp.choices[0].message.content.strip()
            text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            scored = json.loads(text)
            for item in scored:
                all_scores[item["id"]] = item
        except Exception as e:
            st.warning(f"A batch failed to score ({e}); skipping those connections.")
        progress.progress(batch_end / total if total else 1.0, text=ranking_status(batch_end))

    for r in roster:
        s = all_scores.get(r["id"], {"score": 0, "reason": "not scored"})
        r["score"] = s.get("score", 0)
        r["reason"] = s.get("reason", "")
        r["email"] = df.loc[r["id"], email_col] if email_col and pd.notna(df.loc[r["id"], email_col]) else ""

    return sorted(roster, key=lambda x: x["score"], reverse=True)[:normalize_match_count(match_count)]


# ----------------------------------------------------------------------------
# Sidebar: Setup
# ----------------------------------------------------------------------------
with st.sidebar:
    st.header("⚙️ Setup")
    st.toggle("Dark mode", key="dark_mode")

    st.subheader("OpenAI API Key")
    st.text_input(
        "API Key",
        key="openai_api_key",
        type="password",
        help="Get one at platform.openai.com/api-keys. On Streamlit Cloud, you can also set openai_api_key in App secrets.",
    )

    st.divider()

    st.subheader("Your LinkedIn Profile")
    st.caption(
        "Used so drafted messages sound like you. "
        + ("Saved on this computer." if persist_to_disk() else "Kept for this browser session.")
    )
    st.text_input("Your name", key="user_name")
    st.text_input(
        "Your headline / role",
        key="user_headline",
        placeholder="e.g. Founder @ Acme AI | Building tools for sales teams",
    )
    st.number_input(
        "Number of top matches",
        min_value=1,
        max_value=100,
        step=1,
        key="match_count",
        help="Everyone is scored; this is how many of the highest matches to keep.",
    )

    st.divider()
    st.caption(
        "ℹ️ This app never logs into LinkedIn or scrapes it. You provide your own "
        "connections export, and all outreach messages are drafted for you to send "
        "manually, in line with LinkedIn's Terms of Service."
    )

# ----------------------------------------------------------------------------
# Main area
# ----------------------------------------------------------------------------
st.title("🤝 BizDev Coworker")
st.caption("Inside-sales coworker: rank connections for a topic, then draft outreach to send yourself.")

if not get_api_key():
    st.warning("Add your OpenAI API key in the sidebar (or in Streamlit secrets) to get started.")

left, right = st.columns([0.9, 1.15], gap="large")

with left:
    st.subheader("Connections")
    st.caption(
        "Export from LinkedIn: Settings & Privacy → Data Privacy → "
        "'Get a copy of your data' → Connections."
    )
    uploaded = st.file_uploader("Drop Connections.csv here", type=["csv"])

    if uploaded is not None:
        try:
            df = load_connections_csv(uploaded)
            st.session_state.connections_df = df
            st.success(f"Loaded {len(df)} connections.")
            with st.expander("Preview data"):
                st.dataframe(df.head(20), width="stretch")
        except Exception as e:
            st.error(f"Couldn't parse this file: {e}")
    elif st.session_state.connections_df is not None:
        st.caption(f"{len(st.session_state.connections_df)} connections loaded.")

    st.subheader("Topic")
    topic = st.text_area(
        "What do you want to reach out about?",
        key="topic",
        height=68,
        placeholder="e.g. our new AI-powered inventory forecasting tool for retail ops teams",
    )
    match_count = normalize_match_count(st.session_state.get("match_count", 10))
    run_ranking = st.button(f"🔍 Find top {match_count} matches", type="primary", width="stretch")

    if run_ranking:
        df = st.session_state.connections_df
        client = get_client()
        if df is None:
            st.error("Upload your connections CSV first.")
        elif not (topic or "").strip():
            st.error("Enter a topic first.")
        elif client is None:
            st.error("Add your OpenAI API key in the sidebar first.")
        else:
            with st.spinner("Scoring your connections against the topic..."):
                ranked = rank_connections(df, topic, match_count)
            st.session_state.ranked = ranked
            st.session_state.ranked_topic = topic
            st.session_state.drafts = {}
            save_top10()

with right:
    result_count = len(st.session_state.ranked) if st.session_state.ranked else match_count
    st.subheader(f"Top {result_count} matches")
    if st.session_state.ranked:
        topic_label = st.session_state.ranked_topic
        if topic_label:
            st.caption(f"Ranked for: {topic_label}")
        st.caption(
            "Saved on this computer — the list stays after refresh."
            if persist_to_disk()
            else "Kept for this browser session. Export the list if you want a copy."
        )
        st.download_button(
            "Export list",
            data=ranked_export_csv(),
            file_name=f"bizdev_top{result_count}_matches.csv",
            mime="text/csv",
            width="stretch",
        )
        with st.container(height=720, border=True):
            for i, person in enumerate(st.session_state.ranked, start=1):
                with st.container(border=True):
                    c1, c2 = st.columns([3.2, 1])
                    with c1:
                        st.markdown(f"**{i}. {person['name']}**")
                        st.markdown(
                            f"<p class='match-meta'><b>{html.escape(str(person['position']))}</b> at "
                            f"<b>{html.escape(str(person['company']))}</b></p>",
                            unsafe_allow_html=True,
                        )
                        if person.get("email"):
                            st.caption(f"📧 {person['email']}")
                        else:
                            st.caption("No email in export — reach out via LinkedIn.")
                        st.caption(f"Why: {person['reason']}")
                    with c2:
                        st.metric("Score", f"{person['score']}")
                    if st.button("✍️ Draft message", key=f"draft_btn_{person['id']}", width="stretch"):
                        draft_message_dialog(person)
    else:
        st.info(f"Matches will appear here after you upload a list, enter a topic, and find the top {match_count}.")

save_settings()
if st.session_state.ranked:
    save_top10()
