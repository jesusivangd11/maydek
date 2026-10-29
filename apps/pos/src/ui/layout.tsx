import type { KeyboardEvent, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Piezas de composición: tarjeta, encabezado, indicador, estado vacío y
 * modal. Definen el ritmo vertical del sistema —dónde empieza una sección y
 * cuánto respira— para que las tres pantallas lo compartan.
 */

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ── Tarjeta ─────────────────────────────────────────────────────────────────

export function Card({
  title,
  actions,
  flush,
  className,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  /** Sin relleno: para tablas y listas que llegan hasta el borde. */
  flush?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="card__head">
          <h3 className="card__title">{title}</h3>
          {actions}
        </header>
      )}
      <div className={cx('card__body', flush && 'card__body--flush')}>{children}</div>
    </section>
  );
}

// ── Encabezado de pantalla ──────────────────────────────────────────────────

export function PageHeader({
  title,
  subtitle,
  badge,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <h1 className="page-head__title">
          {title}
          {badge}
        </h1>
        {subtitle && <p className="page-head__sub">{subtitle}</p>}
      </div>
      {actions && <div className="page-head__actions">{actions}</div>}
    </header>
  );
}

/** Rótulo de sección: separa bloques sin gastar un título grande en cada uno. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="section-label">{children}</h2>;
}

// ── Indicador ───────────────────────────────────────────────────────────────

export function StatCard({
  label,
  value,
  foot,
  emphasis,
  small,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  /**
   * El dato que manda en la pantalla: fondo teñido y cifra más grande. UNO
   * por pantalla —el efectivo esperado en Caja— o deja de significar nada.
   */
  emphasis?: boolean;
  small?: boolean;
}) {
  return (
    <div className={cx('stat', emphasis && 'stat--key')}>
      <span className="stat__label">{label}</span>
      <span className={cx('stat__value', small && 'stat__value--sm')}>{value}</span>
      {foot && <span className="stat__foot">{foot}</span>}
    </div>
  );
}

// ── Estado vacío ────────────────────────────────────────────────────────────

export function EmptyState({
  icon = 'box',
  title,
  text,
  action,
  boxed,
}: {
  icon?: IconName;
  title: string;
  text?: ReactNode;
  action?: ReactNode;
  boxed?: boolean;
}) {
  return (
    <div className={cx('empty', boxed && 'empty--boxed')}>
      <span className="empty__icon">
        <Icon name={icon} size={26} strokeWidth={1.5} />
      </span>
      <p className="empty__title">{title}</p>
      {text && <p className="empty__text">{text}</p>}
      {action}
    </div>
  );
}

// ── Modal ───────────────────────────────────────────────────────────────────

export function Modal({
  label,
  head,
  foot,
  wide,
  onKeyDown,
  children,
}: {
  label: string;
  head?: ReactNode;
  foot?: ReactNode;
  /** Para tablas y formularios largos: devoluciones, alta de producto… */
  wide?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
}) {
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={label} onKeyDown={onKeyDown}>
      <div className={cx('modal', wide && 'modal--wide')}>
        {head && <header className="modal__head">{head}</header>}
        <div className="modal__body">{children}</div>
        {foot && <footer className="modal__foot">{foot}</footer>}
      </div>
    </div>
  );
}
