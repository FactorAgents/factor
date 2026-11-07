// Stars, drawn: five outlines with the share that is filled laid over them in gilt (4.6 fills four and most of a
// fifth). Never a character: every star is a path, so it looks the same on every phone. Server-safe, no state.

const STAR = "M12 2.6l2.82 5.92 6.48.78-4.76 4.46 1.22 6.42L12 17.02l-5.76 3.16 1.22-6.42-4.76-4.46 6.48-.78z";

function Row({ size, gap }: { size: number; gap: number }) {
  const w = size * 5 + gap * 4;
  return (
    <svg width={w} height={size} viewBox={`0 0 ${(w / size) * 24} 24`} aria-hidden="true" focusable="false">
      {[0, 1, 2, 3, 4].map((i) => <path key={i} d={STAR} transform={`translate(${i * (24 + (gap / size) * 24)} 0)`} />)}
    </svg>
  );
}

/** `value` from 0 to 5; `label` is what a screen reader says. */
export function Stars({ value, size = 14, gap = 3, label }: { value: number; size?: number; gap?: number; label?: string }) {
  const v = Math.max(0, Math.min(5, value));
  // the filled share counts the gaps, so 4.5 fills exactly half of the fifth star
  const whole = Math.floor(v);
  const px = whole * (size + gap) + (v - whole) * size;
  return (
    <span className="stars" role="img" aria-label={label ?? `${v} of 5 stars`}>
      <span className="bg"><Row size={size} gap={gap} /></span>
      <span className="fg" style={{ width: `${px}px` }}><Row size={size} gap={gap} /></span>
    </span>
  );
}

/** One star, for the picker on a review form. */
export function StarMark({ on, size = 26 }: { on: boolean; size?: number }) {
  return (
    <svg className={on ? "on" : undefined} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={STAR} /></svg>
  );
}

/** "4.6 from 3 paid reviews", with the stars: for a list and a page's head. Nothing when there is nothing to say. */
export function ReviewLine({ s, href, size = 12 }: { s: { average: number | null; count: number; notCounted: number }; href?: string; size?: number }) {
  if (!s.count && !s.notCounted) return null;
  const words = s.average === null ? `${s.notCounted} paid review${s.notCounted === 1 ? "" : "s"}, none counted yet` : `${s.average.toFixed(1)} from ${s.count} paid review${s.count === 1 ? "" : "s"}`;
  const inner = <>{s.average !== null ? <Stars value={s.average} size={size} gap={2} label={`${s.average.toFixed(1)} of 5`} /> : null}<span>{words}</span></>;
  return href ? <a className="prv-line" href={href}>{inner}</a> : <span className="prv-line">{inner}</span>;
}
