# Independent QA follow-up — 6 October 2026

The supplied QA report is evidence to investigate, not a claim that every finding is reproducible. This follow-up records fixes and remaining acceptance work.

| Finding | Resolution |
|---|---|
| QA-01 stacked discounts | Fixed. Approval checks cumulative bill and affected-line discounts using unrounded values. Bill locks serialize requests; approvals bind the request and current bill. Regression tests cover stacking, stale approvals and concurrent requests. |
| QA-02 GST setup | Missing GST is now prominent on the home page and tax settings. Actual percentages remain pending accountant confirmation; no rate guessed. |
| QA-03 Cash / UPI | Active Cash drawer and Hotel UPI recording accounts added to the live hotel. No financial transactions created. |
| QA-04 Sheets privacy | Fixed with a fail-closed field whitelist. Phone numbers masked; email, addresses, identity details, free-text notes and payment references excluded. Full owner downloads remain available in the app. |
| QA-05 room price floors | User explicitly chose unrestricted manually entered prices; zero floors are intentional. Above-limit discounts still require approval. |
| QA-06, QA-09 dates | Form C arrival and default export ranges now use the property's timezone. Historical end dates choose the matching financial year. Regression tests added. |
| QA-07, QA-08 release ownership | Public repository/demo fixtures, licensing, main-branch promotion and release tagging need explicit release decisions. No repository visibility or history changed. Railway continues the selected feature branch. |
| QA-10 OTA events | Undated inventory/setup events excluded; source names displayed as readable labels. |
| QA-11 storage | Bounded connection/request/body timeouts and limited retries; storage diagnostics now owner-only. Stalled endpoint regression test added. |
| QA-12 operational accounts / email | Receptionist creation deferred at user's request. Summary recipients and signed Resend delivery webhook remain configuration tasks. Sending previously verified; sender acceptance does not prove webhook status reporting. |
| QA-13 practice records | Cancelled scanner practice booking and abandoned draft retained for audit. No destructive reset or numbering changes. |
| QA-14 guest search | Exact phone/name priority, recent-stay ordering, recent guests on an empty search, and literal wildcard handling. |
| QA-15 security headers | HTML now has CSP, HSTS, anti-framing and no-index headers. CSP permits inline Next.js bootstrap scripts; it is not nonce-based. |
| QA-16, QA-17, QA-18, QA-19 | Alphabetical states, consistent owner night-audit permissions, clearer report/room labels and setup warnings. |
| QA-20 performance | External font dependency removed. Real low-end hotel phone performance remains acceptance work. |
| QA-21 build fonts | Bundled licensed Inter font replaces build-time Google font requests. |
| QA-22 assets / calendar | Favicon, install manifest/icons and distinct room navigation icon added. Calendar respects an exclusive end date and rejects conflicting range inputs. Installation does not imply offline operation. |
| QA-23 IGST | IGST rendered explicitly in bill/invoice totals and PDFs, without fake CGST/SGST rows. |
| QA-24 client IP | Live owner session probe did not match external client egress. Proxy-chain diagnosis remains open; trust was not broadened without proving the boundary. |
| QA-25 bucket enforcement | Application confirmation already verifies uploaded content. Provider-specific rejection of wrong checksums and conditional overwrites needs a deliberate Railway acceptance probe; not claimed verified by local MinIO tests. |

## Handover acceptance

Confirm accountant GST settings, create a separate receptionist account when ready, test actual phone cameras/HEIC and the hotel's printer, and complete the proxy/bucket acceptance checks before calling the hotel handover complete. Google Sheets will be connected when the hotel supplies its sheet. Railway holds primary records and documents; owner downloads remain the portability path.

## Validation of this change

- API: 329 tests passed across 35 files, including cumulative/concurrent discounts, safe Sheets projection, timezones, search and storage timeout regressions.
- Shared: 41 tests passed. Web: 99 tests passed.
- Browser: 16 journeys passed, including mobile navigation and full phone scanner/check-in/checkout flow against isolated test records.
- Production build and workspace typecheck passed. Dependency audit reported no known vulnerabilities. Staged change secret scan found no leaks.
- Local/browser automation cannot replace acceptance on the hotel's actual phone and printer.
