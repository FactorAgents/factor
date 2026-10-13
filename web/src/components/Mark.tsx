// The mark: Factor's F, cream over gold. On the dark ground it is shown as it was drawn; on paper the cream part is
// drawn in ink, so it reads there too. Both are the same shape, cut from the one picture.
export default function Mark({ size = 24 }: { size?: number }) {
  return (
    <span className="mark" style={{ height: size }} aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="on-dark" src="/mark.png" alt="" height={size} width={Math.round(size * 116 / 144)} />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="on-light" src="/mark-light.png" alt="" height={size} width={Math.round(size * 116 / 144)} />
    </span>
  );
}
