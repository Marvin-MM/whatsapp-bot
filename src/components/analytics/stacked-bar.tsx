export interface BarSegment {
  value: number;
  /** A Tailwind `fill-*` class. */
  fillClass: string;
}

/**
 * One horizontal bar split into segments. Drawn as SVG rectangles, not as `style="width: 40%"` divs: an SVG attribute is not CSS, so the page
 * policy (which refuses inline style attributes) needs no exemption for it.
 */
export function StackedBar({ segments, label }: { segments: BarSegment[]; label: string }) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  let offset = 0;
  return (
    <div className="h-2.5 overflow-hidden rounded-full bg-muted">
      <svg viewBox="0 0 100 1" preserveAspectRatio="none" role="img" aria-label={label} className="block h-full w-full">
        {total > 0
          ? segments.map((segment, index) => {
              const width = (segment.value / total) * 100;
              const x = offset;
              offset += width;
              return width > 0 ? <rect key={index} x={x} y={0} width={width} height={1} className={segment.fillClass} /> : null;
            })
          : null}
      </svg>
    </div>
  );
}
