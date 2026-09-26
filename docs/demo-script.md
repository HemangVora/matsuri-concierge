# Demo video script (2–4 minutes, real voice, no speed-up)

**Status at time of writing:** not yet recorded. `ANTHROPIC_API_KEY`, `INTERCEPTA_API_KEY` and `APPROVER_ADDRESS` are still blank in `services/api/.env` / `services/signer/.env`, so the live rehearsal this script describes has not been run end-to-end. This is the exact script to follow once those are filled in.

## Reset before recording

Every previous rehearsal burns real Sepolia gas, MJPY test balances and the local decision log/replay
state. Do this immediately before the take you intend to keep, so the recording starts from a clean,
predictable state and doesn't run into a stale daily-budget ledger or a replayed proposal id:

1. Stop all four services (`Ctrl+C` in each terminal running `dev:api`/`dev:signer`/`dev:friends`/`dev:web`).
2. Delete the local decision/replay state: `rm -f services/api/data.sqlite* services/signer/signer-state.sqlite*`. These are gitignored, service-local databases — deleting them resets the daily spend ledger, the proposal/decision log the `ledger` tool reads, and the signer's replay guards. Nothing on-chain is affected.
3. Re-run the one-time on-chain approvals: `npm run setup:allowance -w services/signer` (agent wallet's MJPY allowance to the voucher contract) — this is idempotent, safe to re-run.
4. Top up test balances: `cd contracts && FUND_AGENT=<agent address> FUND_AOI=<aoi address> FUND_MEI=<mei address> npm run fund && cd ..`. `fund.ts` is idempotent — it tops balances up to its target (¥10,000/¥5,000/¥5,000 MJPY, 0.01 ETH gas each) rather than minting/sending on top of what's already there, so re-running it before every take is safe and cheap.
5. Restart the four services (step 3 of "Before recording" below).

## Before recording — three things that must be true first

1. **Keys set.** `ANTHROPIC_API_KEY` and `INTERCEPTA_API_KEY` in `services/api/.env`, `INTERCEPTA_API_KEY` and `APPROVER_ADDRESS` in `services/signer/.env`, `APPROVER_ADDRESS` set to a MetaMask address you can sign with on Sepolia.
2. **A real flagged address for Kuro Yatai and Ken.** `config/stalls.json`'s stall payouts (`0x1111…1111` … `0x5555…5555`) and `KEN_PAYTO` in `services/api/.env` are currently **placeholders**, not real addresses Intercepta has data on — screening a placeholder will not produce the REFUSE this script depends on. Before recording:
   - Pick a real mainnet address Intercepta's Quick Scan flags (a known-bad address from Intercepta's own test list/Discord), and a separate, clean address for each of stalls 1–4.
   - Set `KEN_PAYTO` to the flagged address directly (no on-chain change needed — it's only read off-chain in `services/api/src/server.ts`).
   - For Kuro Yatai (itemId 5), the payout address is on-chain state in `MatsuriVoucher`. Use `contracts/scripts/set-stall.ts` to repoint it post-deploy without a redeploy: `cd contracts && STALL_ID=5 PAYTO=<flagged address> npm run set-stall` (owner-only; reads the current on-chain price/available via `eventInfo` and keeps them unless `PRICE_YEN`/`AVAILABLE` are also set). Do the same for stalls 1–4 with clean addresses: `STALL_ID=<1..4> PAYTO=<clean address> npm run set-stall`.
   - After every `set-stall` run, update `config/stalls.json`'s matching `payTo` **to match, for the record** — this does not re-deploy or change on-chain state, it just keeps the UI's stall metadata (and this repo's record of what's live) consistent with what `set-stall` just set on-chain.
3. **All four services running:** `npm run dev:api` (:8787), `npm run dev:signer` (:8788), `npm run dev:friends` (:8790), `npm run dev:web` (:5180), plus MetaMask installed and pointed at Sepolia, funded with test ETH for the approver.
4. **MultiBaas event queries confirmed working live.** The Event Queries shape (`purchases()`/`settlements()` in `services/api/src/multibaas.ts`) and `readStalls()`'s array output have only been checked against MultiBaas's docs, not a live account — do not change their filter/orderBy shape blind. Instead, run the live check once before recording: `LIVE=1 npm test -w services/api` (runs `services/api/test/multibaas.live.test.ts` against the real MultiBaas API) and open `http://localhost:8787/api/ledger` once in a browser to confirm the event queries return real rows, not an empty/malformed result.

## The script

**0:00–0:12 — Hook.**
Show the app at `http://localhost:5180`. Read the header aloud: *"Matsuri Concierge — AI creates intent. The missing layer decides whether money moves."* One sentence to camera: "Four separate checks stand between this chat and the chain: policy, Intercepta screening, a human's own signature, and an independent signer that re-checks everything before it moves a yen."

**0:12–0:30 — Order.**
Click the suggestion chip (or type) exactly: `4 of us, ¥3,000, dinner please, get some Kuro Yatai too`. Naming Kuro Yatai explicitly guarantees the agent proposes it (and so guarantees the REFUSE below appears) rather than leaving stall selection to the model's own judgment. While the reply streams, point at the **"The missing layer"** panel filling with `🔎 Intercepta <address> → score …` rows — one per stall — as `propose_order` screens each `payTo`.

**0:30–0:55 — Verdicts.**
Point at the resulting card: `🧾 Order · ¥<total> · awaiting_approval` with one verdict line per stall — `PAY Takoyaki Hachi ×N`, `PAY Yakisoba Ryu ×N`, etc., and `REFUSE Kuro Yatai <the Intercepta trait description>`. Read the chat reply aloud where the agent explains the REFUSE in one line and proposes an alternative stall in its place. Say to camera: "That refusal isn't the model's opinion — it's `packages/core/src/risk.ts` mapping Intercepta's own trait data to a hard REFUSE, and the signer will re-check this exact same thing independently before it ever signs."

**0:55–1:10 — Approval card.**
Point at the `✋ Approve on your phone` link on the card (present because the total is over the ¥1,000 approval threshold). Click it — opens `/approve/<id>` in a new tab.

**1:10–1:35 — Sign.**
On the approval page: read the total, the per-line verdicts, and the proposal hash aloud. Click **"Sign approval"**; MetaMask opens with an EIP-712 `Approval{proposalHash,totalYen,expiresAt}` request — show the typed-data fields in the MetaMask popup, not just a blind signature. Approve it.

**1:35–1:50 — Executed.**
Switch back to the main tab. Point at the new feed row: `✅ Signed by the signer: <tx hash>`. Click the tx hash link — it opens Sepolia Etherscan on the real `buyVoucher` transaction. Say: "That was signed by `services/signer`, a completely separate process — the chat agent never had a private key to sign with."

**1:50–2:10 — Split the bill.**
Type: `Split it: I paid 2600, Ken paid 1800, we're You, Aoi, Mei, Ken.` Point at the new friend-payment rows: `📱 Aoi's agent pays ¥<amount>` and `📱 Mei's agent pays ¥<amount>` buttons, and in the feed a payout line to Ken showing `held` with a reason (Ken's `payTo` is the flagged address set up before recording).

**2:10–2:30 — Friends pay.**
Click **"Aoi's agent pays"**, then **"Mei's agent pays"**. Each button calls `services/friends`, which fetches the 402, signs a `Share` with that friend's own key, and retries. Point at the `🤝 Aoi paid ¥<amount>` / `🤝 Mei paid ¥<amount>` rows appearing in the feed, and the ledger panel's "spent today" and settlement rows updating live.

**2:30–2:50 — Ask about it.**
Type: `What did we spend and why was Kuro Yatai blocked?` Read the agent's reply aloud as it streams — it should quote the exact ledger totals (via the `ledger` tool, backed by MultiBaas Event Queries + the decision log) and repeat the Intercepta trait that caused the REFUSE.

**2:50–3:20 — Negative test (live, in a terminal).**
Cut to a terminal. From the feed above, note the `proposalId` of the fully-refused Kuro-Yatai-only proposal (or trigger one now: propose an order containing only Kuro Yatai). Then:
1. Stop `services/api` (`Ctrl+C` in its terminal).
2. Run:
   ```bash
   curl -s -X POST 127.0.0.1:8788/sign -H 'content-type: application/json' \
     -d '{"proposalId":"<the refused proposal id>"}'
   ```
3. Show the JSON error response (the signer cannot reach the api at `${API_URL}/internal/proposals/:id` to even fetch the proposal, so it fails closed with an HTTP 500/`fetch failed`-style error — it never falls back to trusting a cached or client-supplied answer).
Say to camera: "The signer doesn't just refuse a bad proposal — it refuses everything the moment it can't independently verify what it's being asked to sign, including when the api itself is down."

**3:20–3:30 — Close.**
Restart `services/api`. One closing line: "Everything you just saw — the policy, the Intercepta calls, the signer's checks — is in the README with file and line references. Thanks for watching."

## Notes for whoever records this

- Keep every typed line exactly as written above — the agent is an LLM and paraphrasing changes what tools it calls and in what order, which would desync this script from what's on screen.
- If Intercepta scores the chosen "flagged" address as `CAP` or `ASK` rather than a hard `REFUSE`, say so on camera rather than re-recording until it matches this script — the point is showing the real verdict, not a specific one.
- 720p or better, no sped-up sections, real voice narration throughout (per the submission requirements this script was written against).
