interface AppHeaderProps {
  breadcrumb: string;
  subtitle?: string;
  onBack?: () => void;
}

export function AppHeader({ breadcrumb, subtitle, onBack }: AppHeaderProps) {
  return (
    <header className="app-header">
      {onBack && (
        <button className="app-header__back" onClick={onBack} aria-label="Terug">
          ←
        </button>
      )}
      <div className="app-header__title">
        <div className="app-header__breadcrumb">{breadcrumb}</div>
        {subtitle && <div className="app-header__subtitle">{subtitle}</div>}
      </div>
    </header>
  );
}
