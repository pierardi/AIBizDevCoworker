"""
AI Coworker for LinkedIn Outreach
==================================

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

SETUP
-----
pip install streamlit openai pandas
streamlit run linkedin_coworker.py
"""

import json
import io
import pandas as pd
import streamlit as st
from openai import OpenAI

st.set_page_config(page_title="AI Outreach Coworker", page_icon="🤝", layout="wide")

# ----------------------------------------------------------------------------
# Session state
# ----------------------------------------------------------------------------
defaults = {
    "openai_api_key": "",
    "user_name": "",
    "user_headline": "",
    "user_about": "",
    "connections_df": None,
    "ranked": None,
    "drafts": {},
}
for k, v in defaults.items():
    if k not in st.session_state:
        st.session_state[k] = v


def get_client():
    if not st.session_state.openai_api_key:
        return None
    return OpenAI(api_key=st.session_state.openai_api_key)


# ----------------------------------------------------------------------------
# Sidebar: Setup
# ----------------------------------------------------------------------------
with st.sidebar:
    st.header("⚙️ Setup")

    st.subheader("OpenAI API Key")
    st.session_state.openai_api_key = st.text_input(
        "API Key",
        value=st.session_state.openai_api_key,
        type="password",
        help="Get one at platform.openai.com/api-keys. Stored only in this session, never written to disk.",
    )

    st.divider()

    st.subheader("Your LinkedIn Profile")
    st.caption("This context helps the AI write messages that sound like you and match your positioning.")
    st.session_state.user_name = st.text_input("Your name", value=st.session_state.user_name)
    st.session_state.user_headline = st.text_input(
        "Your headline / role", value=st.session_state.user_headline,
        placeholder="e.g. Founder @ Acme AI | Building tools for sales teams"
    )
    st.session_state.user_about = st.text_area(
        "Short bio / what you do", value=st.session_state.user_about, height=120,
        placeholder="A couple sentences about your work, so drafted messages have the right context."
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
st.title("🤝 AI Outreach Coworker")
st.write(
    "Find the connections most likely to care about a topic, and get a "
    "personalized message drafted for each one."
)

if not st.session_state.openai_api_key:
    st.warning("Add your OpenAI API key in the sidebar to get started.")

# Step 1: Upload connections CSV
st.header("1. Upload your LinkedIn connections")
st.caption(
    "Export from LinkedIn: Settings & Privacy → Data Privacy → "
    "'Get a copy of your data' → Connections. You'll receive a Connections.csv by email."
)
uploaded = st.file_uploader("Connections.csv", type=["csv"])

if uploaded is not None:
    raw = uploaded.read().decode("utf-8", errors="ignore")
    # LinkedIn's export has a few "Notes:" preamble lines before the real header row.
    lines = raw.splitlines()
    header_idx = 0
    for i, line in enumerate(lines):
        if "First Name" in line and "Last Name" in line:
            header_idx = i
            break
    csv_body = "\n".join(lines[header_idx:])
    try:
        df = pd.read_csv(io.StringIO(csv_body))
        df.columns = [c.strip() for c in df.columns]
        st.session_state.connections_df = df
        st.success(f"Loaded {len(df)} connections.")
        with st.expander("Preview data"):
            st.dataframe(df.head(20), use_container_width=True)
    except Exception as e:
        st.error(f"Couldn't parse this file: {e}")

# Step 2: Topic + ranking
st.header("2. Enter a topic")
topic = st.text_input(
    "What do you want to reach out about?",
    placeholder="e.g. our new AI-powered inventory forecasting tool for retail ops teams"
)

col1, col2 = st.columns([1, 3])
with col1:
    run_ranking = st.button("🔍 Find top 10 matches", type="primary", use_container_width=True)

if run_ranking:
    df = st.session_state.connections_df
    client = get_client()
    if df is None:
        st.error("Upload your connections CSV first.")
    elif not topic.strip():
        st.error("Enter a topic first.")
    elif client is None:
        st.error("Add your OpenAI API key in the sidebar first.")
    else:
        with st.spinner("Scoring your connections against the topic..."):
            # Build a compact roster; batch to keep prompts manageable
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
            progress = st.progress(0.0)
            for start in range(0, len(roster), batch_size):
                batch = roster[start:start + batch_size]
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
                progress.progress(min(1.0, (start + batch_size) / len(roster)))

            for r in roster:
                s = all_scores.get(r["id"], {"score": 0, "reason": "not scored"})
                r["score"] = s.get("score", 0)
                r["reason"] = s.get("reason", "")
                r["email"] = df.loc[r["id"], email_col] if email_col and pd.notna(df.loc[r["id"], email_col]) else ""

            ranked = sorted(roster, key=lambda x: x["score"], reverse=True)[:10]
            st.session_state.ranked = ranked
            st.session_state.drafts = {}

# Step 3: Show top 10 + draft messages
if st.session_state.ranked:
    st.header("3. Top 10 matches")
    client = get_client()

    for i, person in enumerate(st.session_state.ranked, start=1):
        with st.container(border=True):
            c1, c2 = st.columns([3, 1])
            with c1:
                st.subheader(f"{i}. {person['name']}")
                st.write(f"**{person['position']}** at **{person['company']}**")
                if person.get("email"):
                    st.write(f"📧 {person['email']}")
                else:
                    st.caption("No email in export — reach out via LinkedIn directly.")
                st.caption(f"Why: {person['reason']}")
            with c2:
                st.metric("Match score", f"{person['score']}/100")

            draft_key = person["id"]
            gen = st.button(f"✍️ Draft message", key=f"draft_btn_{draft_key}")
            if gen:
                if client is None:
                    st.error("Add your OpenAI API key in the sidebar first.")
                else:
                    with st.spinner("Drafting..."):
                        msg_prompt = f"""Write a short, warm, non-salesy LinkedIn message from \
{st.session_state.user_name or "me"} ({st.session_state.user_headline or ""}) to {person['name']}, \
who works as {person['position']} at {person['company']}.

About the sender: {st.session_state.user_about or "no extra bio provided"}

The message should introduce this topic and gauge interest, referencing why it's \
relevant to their role: "{topic}"

Keep it under 80 words, first name only greeting, conversational tone, one clear \
soft call to action (e.g. "worth a quick chat?"). No hashtags, no emojis, no signature block."""
                        resp = client.chat.completions.create(
                            model="gpt-4o-mini",
                            messages=[{"role": "user", "content": msg_prompt}],
                            temperature=0.7,
                        )
                        st.session_state.drafts[draft_key] = resp.choices[0].message.content.strip()

            if draft_key in st.session_state.drafts:
                st.text_area(
                    "Drafted message (copy and send via LinkedIn or email)",
                    value=st.session_state.drafts[draft_key],
                    height=140,
                    key=f"draft_text_{draft_key}",
                )
