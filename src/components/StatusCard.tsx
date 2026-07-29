import type { ReactNode } from 'react';

interface StatusCardProps {
  label: string;
  value: ReactNode;
  detail: string;
}

export function StatusCard({ label, value, detail }: StatusCardProps) {
  return (
    <article className="status-card">
      <p className="status-card__label">{label}</p>
      <p className="status-card__value">{value}</p>
      <p className="status-card__detail">{detail}</p>
    </article>
  );
}
