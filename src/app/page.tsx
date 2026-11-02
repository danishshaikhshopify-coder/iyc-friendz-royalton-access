/**
 * Root page. This service has no customer-facing home page of its own —
 * real traffic hits the App Proxy route (src/app/apps/royalton-access)
 * and the webhook routes. This page exists only so `next build` has a
 * valid App Router root, and returns a minimal, non-sensitive status
 * message if hit directly.
 */
export default function RootPage() {
  return (
    <main style={{ fontFamily: "monospace", padding: 24 }}>
      <p>royalton-access service is running.</p>
    </main>
  );
}
