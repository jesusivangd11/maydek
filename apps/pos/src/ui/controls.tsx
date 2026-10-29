import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Controles.
 *
 * Un botón, un campo y un buscador para TODO el sistema. La razón no es
 * ahorrar líneas: es que Vender, Caja y Ventas no puedan divergir. Antes cada
 * pantalla se inventaba su propio tamaño de botón y su propio borde, y al
 * cabo de tres pantallas ya no parecía el mismo programa.
 */

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ── Botón ───────────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'subtle' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

export function Button({
  variant = 'secondary',
  size = 'md',
  block,
  icon,
  shortcut,
  className,
  children,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: IconName;
  /** Tecla asociada. Se pinta dentro del botón, apagada: se aprende sola. */
  shortcut?: string;
  ref?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(
        'btn',
        `btn--${variant}`,
        size !== 'md' && `btn--${size}`,
        block && size !== 'xl' && 'btn--block',
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'sm' ? 16 : 18} />}
      {children}
      {shortcut && <kbd className="btn__key">{shortcut}</kbd>}
    </button>
  );
}

// ── Campo de texto ──────────────────────────────────────────────────────────

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <span className="field__hint">{hint}</span>}
    </div>
  );
}

export function TextInput({
  amount,
  large,
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  /** Importe: alto, seminegrita y cifras tabulares. */
  amount?: boolean;
  large?: boolean;
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <input
      ref={ref}
      className={cx('input', amount && 'input--amount', large && 'input--lg', className)}
      {...rest}
    />
  );
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx('select', className)} {...rest}>
      {children}
    </select>
  );
}

// ── Buscador ────────────────────────────────────────────────────────────────

export function SearchInput({
  compact,
  busy,
  shortcut,
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  compact?: boolean;
  busy?: boolean;
  shortcut?: string;
  ref?: Ref<HTMLInputElement>;
}) {
  return (
    <div className={cx('search', compact && 'search--compact', className)}>
      <input ref={ref} type="text" className="search__input" {...rest} />
      <span className="search__icon">
        <Icon name="search" size={compact ? 18 : 21} />
      </span>
      {(busy || shortcut) && (
        <span className="search__tail">
          {busy && <span className="spinner" aria-label="Buscando" />}
          {shortcut && !busy && <kbd className="kbd">{shortcut}</kbd>}
        </span>
      )}
    </div>
  );
}

// ── Control segmentado ──────────────────────────────────────────────────────

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  block,
  large,
  disabled,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  block?: boolean;
  large?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div
      className={cx('segmented', block && 'segmented--block', large && 'segmented--lg')}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented__item"
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ── Distintivo de estado ────────────────────────────────────────────────────

export type Tone = 'neutral' | 'positive' | 'warning' | 'danger' | 'info';

export function Badge({
  tone = 'neutral',
  large,
  dot = true,
  children,
  title,
}: {
  tone?: Tone;
  large?: boolean;
  /** Sin punto para etiquetas que no comunican un estado (un rol, un conteo). */
  dot?: boolean;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      className={cx(
        'badge',
        tone !== 'neutral' && `badge--${tone}`,
        large && 'badge--lg',
        !dot && 'badge--bare',
      )}
      title={title}
    >
      {children}
    </span>
  );
}

// ── Aviso ───────────────────────────────────────────────────────────────────

export function Alert({
  tone = 'danger',
  children,
}: {
  tone?: 'danger' | 'warning';
  children: ReactNode;
}) {
  return (
    <p className={cx('alert', tone === 'warning' && 'alert--warning')} role="alert">
      <Icon name="alert" size={18} className="alert__icon" />
      <span>{children}</span>
    </p>
  );
}
