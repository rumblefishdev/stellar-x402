---
title: "The lost-access drill on production (testnet), 2026-11-26"
type: generation
status: mature
spawns: []
tags: [keys, openbao, drill, runbook]
links:
  - ../../../../../docs/runbook.md
  - ../../../../../docs/adr/0015-hot-key-full-power.md
history:
  - date: "2026-11-26"
    status: mature
    who: okarcz
    note: "The timed drill of docs/runbook.md, \"Lost access to the facilitator's accounts\", on the production server (testnet)."
---

# The lost-access drill on production (testnet), 2026-11-26

The runbook's "Lost access to the facilitator's accounts", steps 1–7, run by okarcz on ch-prod-01
(production, testnet) after the ninth deploy (#260, `830c836e`) put #235's `compose.yaml` in
place. The row of step 2 played: the server stays, OpenBao keeps its data, so the key gets a new
version under the same name, decided before the drill (step 2). Announced in the team channel
first.

## Result

- **Down 17 min 10 s:** `x402@production` stopped at 10:41:55 UTC and started with `signer: ok`
  at 10:59:05 UTC. Without the empty credential (below) it would have been 12 min 49 s: the first
  start came at 10:54:44.
- **ADR 0015's "about an hour" holds,** with room for a night call and typing. Step 7 doesn't
  count: the facilitator doesn't wait for it.
- **Key:** `stellar-testnet` at version 2, `min_encryption_version` 2. The AppRole's tokens were
  revoked and its one secret ID (accessor `88c7fa2b…`) destroyed.
- **New fee account:** `GDV2PC2U7QGHWHOFNA34XRGIINFTZDPMJSJOTVNQ72UIBL6IY2KESBWP`, 10,000 XLM
  from Friendbot.
- **20 new channels,** 1.5 XLM each, the new key their only signer, in two transactions:
  `96495fda09f38260a37ea0539eb382676dca054895e3e2e4e10d77b67e8ab960` (19) and
  `4797cad0f39982372f681e981a2fc39be9259589a1a46c58ebc9e606a93baa11` (1). 19 is the most a
  transaction can create: the funder's signature and one per channel, at most 20
  (`MAX_CHANNELS_PER_TX`, `packages/signer-pool/src/setup.ts:36`).
- **`.env`:** `OPENBAO_KEY_VERSION_TESTNET=2`, the new address and the new channels; Compose
  read them. `/supported` lists the new address; `/health` answers `ready`, `listed` and
  `signer: "ok"`.
- **A paid request settled** on the new accounts at 11:05:43 UTC, a real one, not run by hand
  (okarcz chose not to run one): fee bump
  `08c63976de4f2f2ee1350f988d1e7d6dff56774ad4c814203b52d6da002914f8`, paid by the new fee
  account from channel `GDMDINTL…`, a 0.001 USDC `transfer`. Step 6's done signal is met.
- **Step 7 (the alarms):** #261 changed `feeAccounts`; Watch was deployed at about 14:15 UTC and
  Alarms at about 14:25 UTC. Each diff showed only the account, plus, in Watch, 0029's upstream
  section, merged on 2026-11-09 and not deployed until now. `upstream` stays off in
  `production.json`, so it publishes and pages nobody.
- **Snapshot after it:** `openbao-2026-11-26T11:03:30Z`, started by hand (stkrolikiewicz's ask),
  so version 2 is off the server before the nightly run.

**Abandoned under key version 1,** by choice: version 1 is still in OpenBao, and only
`min_encryption_version` stops it signing, which a root token could lower. After a real theft
the thief holds these accounts; here nobody moves them:

- The fee account `GAVE5V5IOMNNBOZXGZSQOP447L2QLCG6ELIIPO6CFJLGZVY4YIK3KKRP`, with 9,998.8 XLM
  spendable (testnet, from Friendbot).
- Its 20 channels: `GAZRJX2NMDBFBGHZBMYYKCVVX75UXRWOIIAZSXWWRMQKMV37Q5P3SAHK`,
  `GCP3HFPW6HOT4X6DOFCRXZ37B6CTAINMF4GQPQQFKMGOO6PYYPDE3WAR`,
  `GD2VZZFGFDELMDCBRVTCUXNO6DENRDQDNY6BTMWJZQE6XXXLGNRZ4ART`,
  `GBNU6K72BOJQ5Z2CSQDVLNBQXIEXFJBLOF4MF5BZAGPYKQL2RG5VDNOR`,
  `GCQF5FSLSL73576CF7DBMDSVYNILW2GKUYRDDPJKGBFL2N7B56DXDSZJ`,
  `GCSBGPOWO5K3JTGVPYSCRJFTN3N3GVNN6O2PEWN6CDSATUQHERKUQH7H`,
  `GBS2ICSATZKVLLF7HOJTSB33YD6U5NXM4ZGH2JL4ZBA4QCO4YLMIYW2J`,
  `GAJ4AB6IMCEECMKLIJQPBE2I2B57ZHVCQ6WKFLBB2LSW37QN6N3EGAAM`,
  `GDJDZS3CWFXIW3LW4WYPF4YRLB4XBTDK6BQDTHNJ2QZ7JH3CIODKOYFC`,
  `GAYXILRWIPNJBLMSURQZOCDBI4E6XVGCPAFQZHWDPYYVTRHGMF3MA5BV`,
  `GBETYWA4XDLDWX5CFP3UBOCAF6TBPIU5ITPGXR53ZSQAGPCYMVBNOZXU`,
  `GB3L2QZ5JWPL4UNHV2A76XQVKWJ5GJ63VGKRJTCWZBOFHKUOKVP5J34O`,
  `GD7WZBZFCGJIBFQNFMFJPUBMZY3AU36OXIOJZSVJPPKXXIIOOQBM75XR`,
  `GCDU3VKENEE3XMKBBEV3WP5TFK7KX2JVJG53D3K42JQWOLM3GXSN4HWV`,
  `GCAJEXQGHK6Y44FRMYQWCQGGB6ABX65M3ZYKYVJCSQ7PJNA4VFXMUIEJ`,
  `GARFJGXZ3IFWVA7AP6CTV6TZKPAQFFAZUMRN3YKOLWGKCRETDBJJGPNZ`,
  `GDLEV2OWUTNLZOFPUNX2CCV7NO57BYEJSRKZ7K7QQQXFDAJFGJ6GX37W`,
  `GBXEO7YQIPNCDPC4SNTDHDBJWH4TUBO6IXNTGYI3AWTZK2ALG4PBIYDF`,
  `GAIOIGHY4ESSBAR4KHWT5OAC6LECRR3GBQO35RYARHTOX2QXLK2OFYOF`,
  `GBKTXAHZBA3657N45MD5WSO6W3KQGW2AZ7BTJ2NDWMDOIFHZI3GL5FLK`.

## Timeline (UTC)

| Time        | Step                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------------- |
| 10:37       | Ninth deploy checked: Compose reads `OPENBAO_KEY` and its version from `.env`, `signer: ok`        |
| 10:41:55    | Step 1: `x402@production` stopped                                                                  |
| 10:42–10:44 | A new root token from the recovery key ("A new root token")                                        |
| 10:46–10:48 | Step 3: rotate to version 2, `min_encryption_version` 2, `revoke-prefix`, the secret ID destroyed  |
| 10:50–10:51 | Step 3: the credential written (empty, see below), the address read, the root token revoked        |
| 10:52–10:53 | Step 4: the fee account from Friendbot, 20 channels in two transactions                            |
| 10:54       | Step 5: `.env.new` read back and moved to `.env`                                                   |
| 10:54:44    | Step 6: start; it failed at once, and systemd gave up at 10:55:17                                  |
| 10:56–10:59 | Fix: a new root token, the orphan secret ID destroyed, a new one written and decrypted (36 bytes)  |
| 11:05:43    | A real paid request settles through the new fee account and channel `GDMDINTL…`                    |
| 10:59:05    | Step 6 again: `reset-failed`, start, `signer: ok`, `/supported` lists the new address              |
| 11:03:30    | OpenBao snapshot by hand                                                                           |
| 14:15–14:25 | Step 7: Watch and Alarms deployed on the new account                                               |

## What went wrong, and what changed in the runbook

- **An empty secret ID credential.** The guide used for the drill split step 3's guarded line
  in two: one paste took the secret ID into `$s`, a later one encrypted it and ran `unset s`,
  with no `[ -n "$s" ]`. The guide gave that encrypt line twice, at 10:48 as step 7b and again
  at 10:50 as the first of the remaining commands; most likely it ran both times, so the second
  run encrypted an empty `$s` over the good credential (the file's time is 10:50). The
  facilitator stopped at its config check with `OPENBAO_SECRET_ID_FILE is empty`
  (`apps/facilitator/src/config.ts:541`). The root token was already revoked, so the fix took a
  new one: destroy the orphan secret ID (accessor `e77bb10a…`), write a new one guarded, decrypt
  it to check 36 bytes, `reset-failed`, start. It cost 4 min 21 s. The runbook's own line was
  guarded all along. It now says to paste that line whole and run each line once, compares the
  decrypted credential with `$s` (a byte count would pass on the old file), and step 6 says how
  to recover.
- **A long line cut in the paste.** Step 3's `for` loop over the secret IDs was one long line;
  pasted, it reached the shell cut and left it at a continuation prompt. Ctrl-C, then
  `revoke-prefix` again (it is idempotent). The loop is now on several lines, with the IDs
  printed first.
- **`.env` emptied before the drill.** At about 09:43, a whole-file `install` of `.env` with
  placeholders, printed ahead of its step by the drill's guide, ran by accident: the shell
  refused the placeholders, but the `ssh … install /dev/stdin …/.env` still ran and left `.env`
  empty. The running facilitator didn't notice, since it reads `.env` only at a start. By 09:49
  `.env` was back from the copy printed at 09:16, through `.env.new` and a byte-for-byte diff. Step 5 now writes `.env.new`, reads it back with
  `cat -A` in its own paste, and only then moves it over `.env`, keeping `.env.old` and refusing
  a file without its channels.
- **A manual snapshot replaces the day's earlier one.** `borg prune --keep-daily 14`
  (`deploy/libexec/x402-openbao-snapshot:94`) keeps the last archive of each day, so 11:03:30
  replaced that night's 03:26:05. Nothing is lost: the later archive holds everything the earlier
  one did. Written next to the runbook's new "snapshot after it" line.
- **The recovery key file is 45 bytes,** the 44-character key and `jq`'s newline. The runbook
  checks `${#key}` after `$(cat …)`, which drops the newline, so it reads 44 as it should.
  Nothing to change.
