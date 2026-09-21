export interface SimpleLineChartPoint {
  label: string;
  value: number;
}

interface SimpleLineChartProps {
  points: SimpleLineChartPoint[];
}

/**
 * Eenvoudige, rustige lijngrafiek (spec v0.2.1 §8: "geen uitgebreide
 * analytics"). Puur inline SVG — geen chart-bibliotheek nodig voor één
 * enkele lijn, en dat houdt de offline-PWA-bundel klein. Enkel echte
 * historische punten worden getekend (de aanroeper, ArticleDetailPage,
 * geeft hier nooit geschatte waarden aan mee).
 */
export function SimpleLineChart({ points }: SimpleLineChartProps) {
  if (points.length === 0) {
    return <p className="empty-state">Nog geen historische tellingen.</p>;
  }

  const width = 640;
  const height = 220;
  const paddingX = 40;
  const paddingY = 24;

  const values = points.map((p) => p.value);
  const minValue = Math.min(0, ...values);
  const maxValue = Math.max(...values, minValue + 1);

  const xStep = points.length > 1 ? (width - paddingX * 2) / (points.length - 1) : 0;
  const yForValue = (value: number) => {
    const ratio = (value - minValue) / (maxValue - minValue);
    return height - paddingY - ratio * (height - paddingY * 2);
  };
  const xForIndex = (index: number) => paddingX + index * xStep;

  const coords = points.map((point, index) => ({
    x: points.length === 1 ? width / 2 : xForIndex(index),
    y: yForValue(point.value),
    point,
  }));

  const polylinePoints = coords.map((c) => `${c.x},${c.y}`).join(" ");

  // Bij veel punten enkel de eerste/laatste (en om en om) x-labels tonen, anders overlappen ze.
  const labelStep = Math.max(1, Math.ceil(points.length / 6));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="line-chart"
      role="img"
      aria-label="Voorraad doorheen de tijd"
    >
      <line
        x1={paddingX}
        y1={yForValue(minValue)}
        x2={width - paddingX}
        y2={yForValue(minValue)}
        className="line-chart__axis"
      />
      {coords.length > 1 && (
        <polyline points={polylinePoints} className="line-chart__line" fill="none" />
      )}
      {coords.map((c, index) => (
        <g key={c.point.label + index}>
          <circle cx={c.x} cy={c.y} r={4} className="line-chart__dot" />
          {(index === 0 || index === coords.length - 1 || index % labelStep === 0) && (
            <text x={c.x} y={height - 4} textAnchor="middle" className="line-chart__label">
              {c.point.label}
            </text>
          )}
          <text x={c.x} y={c.y - 10} textAnchor="middle" className="line-chart__value">
            {c.point.value}
          </text>
        </g>
      ))}
    </svg>
  );
}
