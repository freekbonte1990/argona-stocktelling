interface ProgressBarProps {
  label: string;
  done: number;
  total: number;
}

export function ProgressBar({ label, done, total }: ProgressBarProps) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div>
      <div className="progress-label">
        <span>{label}</span>
        <span>
          {done} / {total}
        </span>
      </div>
      <div className="progress-bar">
        <div className="progress-bar__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
