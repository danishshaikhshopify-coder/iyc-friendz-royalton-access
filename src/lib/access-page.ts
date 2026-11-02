/**
 * HTML rendering for the secure Royalton access page, served through the
 * Shopify App Proxy. Branded dark green / black / gold / white, matching
 * the Checkout Blocks copy from the existing (Task 17 Phase 1) block.
 *
 * Security note: this module NEVER receives or renders a reason string
 * tied to a specific ineligibility cause when the state is "ineligible".
 * Every denial — wrong product, unpaid, cancelled, refunded, invalid
 * token, revoked token, order not found, admin-api lookup failure — is
 * rendered with the exact same generic copy. This is deliberate: telling
 * an unauthenticated requester *why* a token was rejected (e.g. "this
 * order was refunded") would leak order information to anyone who merely
 * guesses or intercepts a URL shape, even without a valid token.
 */

export type AccessPageState =
  | { kind: "eligible"; bookingUrl: string }
  | { kind: "eligible_url_pending" }
  | { kind: "ineligible" }
  | { kind: "rate_limited" }
  | { kind: "error" };

const PAGE_SHELL_OPEN = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Royalton Booking Access</title>
    <style>
      :root {
        --ink-black: #0b1f17;
        --deep-green: #12351f;
        --gold: #c9a24b;
        --white: #ffffff;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: linear-gradient(160deg, var(--ink-black) 0%, var(--deep-green) 100%);
        color: var(--white);
        font-family: Georgia, 'Times New Roman', serif;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      .card {
        max-width: 480px;
        width: 100%;
        border: 1px solid var(--gold);
        border-radius: 10px;
        padding: 32px 28px;
        background: rgba(0, 0, 0, 0.25);
      }
      h1 {
        color: var(--gold);
        font-size: 22px;
        letter-spacing: 0.4px;
        margin: 0 0 16px;
        line-height: 1.3;
      }
      p {
        font-size: 15px;
        line-height: 1.6;
        margin: 0 0 16px;
      }
      .btn {
        display: inline-block;
        background: var(--gold);
        color: var(--ink-black);
        font-weight: bold;
        text-decoration: none;
        padding: 14px 28px;
        border-radius: 4px;
        font-size: 14px;
        letter-spacing: 0.4px;
        margin-top: 8px;
      }
      .muted {
        color: #cfd8d2;
        font-size: 13px;
        margin-top: 20px;
      }
    </style>
  </head>
  <body>
    <div class="card">`;

const PAGE_SHELL_CLOSE = `
    </div>
  </body>
</html>`;

export function renderAccessPageHtml(state: AccessPageState): string {
  switch (state.kind) {
    case "eligible":
      return (
        PAGE_SHELL_OPEN +
        `
      <h1>YOUR ROYALTON BOOKING LINK IS READY!</h1>
      <p>Your IYC &amp; FRIENDZ Event Pass purchase is confirmed.</p>
      <p>Your hotel reservation at Royalton Bavaro is separate from your Event Pass.
         A one-night deposit is required to secure your room. The remaining balance
         is payable directly at the resort.</p>
      <a class="btn" href="${escapeAttr(state.bookingUrl)}" rel="noopener noreferrer">BOOK YOUR ROYALTON ROOM</a>` +
        PAGE_SHELL_CLOSE
      );

    case "eligible_url_pending":
      return (
        PAGE_SHELL_OPEN +
        `
      <h1>YOUR BOOKING LINK IS ALMOST READY</h1>
      <p>Your IYC &amp; FRIENDZ Event Pass purchase is confirmed, and you're eligible to
         book your Royalton room.</p>
      <p>We're finalizing the private booking link with the resort. Please check back
         soon — you can reopen this page any time using the same link from your email.</p>` +
        PAGE_SHELL_CLOSE
      );

    case "rate_limited":
      return (
        PAGE_SHELL_OPEN +
        `
      <h1>TOO MANY REQUESTS</h1>
      <p>Please wait a moment and try again.</p>` +
        PAGE_SHELL_CLOSE
      );

    case "error":
      return (
        PAGE_SHELL_OPEN +
        `
      <h1>SOMETHING WENT WRONG</h1>
      <p>We couldn't load your booking information right now. Please try again in a
         few minutes. If the problem continues, contact us for help.</p>` +
        PAGE_SHELL_CLOSE
      );

    case "ineligible":
    default:
      return (
        PAGE_SHELL_OPEN +
        `
      <h1>LINK NOT AVAILABLE</h1>
      <p>This booking link isn't available for this request. If you believe this is a
         mistake, please contact us and we'll be happy to help.</p>
      <p class="muted">For your security, we don't share the reason a link request was
         declined on this page.</p>` +
        PAGE_SHELL_CLOSE
      );
  }
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
