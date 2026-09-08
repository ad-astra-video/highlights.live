// Shown in the dev/wireframe environment so it's obvious billing is simulated.
export function DevBanner() {
  return (
    <div className="mb-4 flex items-center justify-center gap-2 rounded-xl border border-pink/40 bg-pink/10 px-4 py-2 text-sm text-pink">
      <span className="h-2 w-2 animate-pulse rounded-full bg-pink" />
      DEV WIREFRAME — billing is simulated (no live Stripe). Wireframe controls on the Billing page.
    </div>
  );
}
