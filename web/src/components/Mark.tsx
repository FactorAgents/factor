// The mark: an F whose lower arm is half the upper one. Half now, the rest on delivery.
export default function Mark({ size = 27 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <path d="M12 8h40a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H28v6h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H28v12a2 2 0 0 1-2 2H12a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z" fill="var(--go)" />
    </svg>
  );
}
