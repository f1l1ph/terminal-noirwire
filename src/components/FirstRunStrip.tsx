import { btnPrimary } from "@/components/ui/styles";

export function FirstRunStrip({
  hasWallet,
  onCreateWallet,
  creating,
}: {
  hasWallet: boolean;
  onCreateWallet: () => void;
  creating: boolean;
}) {
  if (hasWallet) return null;
  return (
    <div className="border-line-subtle bg-surface rounded-panel flex flex-wrap items-center justify-between gap-3 border px-4 py-3">
      <p className="text-ink text-[14px]">Trade with test funds on a test network.</p>
      <button type="button" className={btnPrimary} disabled={creating} onClick={onCreateWallet}>
        {creating ? "Creating…" : "Create test wallet"}
      </button>
    </div>
  );
}
