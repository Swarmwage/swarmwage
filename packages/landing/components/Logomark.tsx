// Notched square — Swarmwage primary mark.
//
// Geometry: a 100×100 square with the top-right corner cut as a 90° inward
// notch at 30% of the edge. Reads as: a closed perimeter opened at one vertex
// — the protocol vertex. Single SVG path, 6 vertices, single fill, no stroke,
// no rounded corners.
//
// At Day 90 the Swarm L3 sub-brand inherits the same primitive without the
// notch (closed perimeter = consumer reliability). One brand, two promises.

export function Logomark({
  size = 24,
  color = "currentColor",
  className,
}: {
  size?: number;
  color?: string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill={color}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      className={className}
    >
      <path d="M 0 0 L 70 0 L 70 30 L 100 30 L 100 100 L 0 100 Z" />
    </svg>
  );
}
