import { useState } from 'react';
import { api, type StockRow } from '@pos/lib/api';
import { formatDateTime, formatMoney, formatQty } from '@pos/lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  SearchInput,
  Select,
  TextInput,
} from '@pos/ui';
import type { ScreenProps } from '../App';
import { VariantPicker } from '../components/VariantPicker';
import { can, downloadCsv, errorText, useLoad } from '../lib/util';

/**
 * Inventario.
 *
 * La existencia NO se edita: se AJUSTA, con motivo, y el ajuste queda en el
 * kardex con quién, cuándo y por qué. Se captura lo CONTADO, no la diferencia:
 * el sistema calcula cuánto entra o sale. Así un conteo físico se teclea tal
 * cual se hizo, sin restar de cabeza.
 */

const MOVEMENT_LABELS: Record<string, string> = {
  INITIAL_LOAD: 'Carga inicial',
  PURCHASE_RECEIPT: 'Compra',
  SALE: 'Venta',
  SALE_CANCEL: 'Cancelación',
  RETURN_IN: 'Devolución',
  RETURN_OUT: 'Devolución a proveedor',
  ADJUSTMENT_IN: 'Ajuste (+)',
  ADJUSTMENT_OUT: 'Ajuste (−)',
  COUNT_CORRECTION: 'Conteo',
  TRANSFER_OUT: 'Traspaso salida',
  TRANSFER_IN: 'Traspaso entrada',
  DAMAGE: 'Merma',
  SCRAP: 'Desecho',
};

const ADJUST_REASONS = [
  { code: 'CONTEO_FISICO', label: 'Conteo físico' },
  { code: 'CARGA_INICIAL', label: 'Carga inicial de inventario' },
  { code: 'MERMA', label: 'Merma o daño' },
  { code: 'ROBO', label: 'Robo o extravío' },
  { code: 'CORRECCION', label: 'Corrección de captura' },
];

export function InventoryScreen({ user }: ScreenProps) {
  const [search, setSearch] = useState('');
  const [onlyLow, setOnlyLow] = useState(false);
  const [kardexOf, setKardexOf] = useState<StockRow | null>(null);
  const [adjusting, setAdjusting] = useState<StockRow[] | null>(null);
  const stock = useLoad(
    () => api.listStock({ search: search || undefined, onlyLow: onlyLow || undefined, limit: 200 }),
    [search, onlyLow],
  );
  const showCost = can(user.permissions, 'product.cost.view');
  const canAdjust = can(user.permissions, 'inventory.adjust');
  const canKardex = can(user.permissions, 'inventory.kardex.view');

  const rows = stock.data?.data ?? [];
  const totalValue = rows.reduce((acc, r) => acc + Number(r.stockValue ?? 0), 0);

  return (
    <div className="page">
      <PageHeader
        title="Inventario"
        subtitle="Existencias del almacén de la sucursal, kardex y ajustes."
        actions={
          <>
            {canAdjust && (
              <Button variant="primary" icon="edit" onClick={() => setAdjusting([])}>
                Ajustar inventario
              </Button>
            )}
            {showCost && (
              <Button
                variant="secondary"
                icon="download"
                onClick={async () => {
                  const rows = await api.inventoryValuation();
                  downloadCsv('valuacion-inventario.csv', rows.map((r) => ({
                    SKU: r.sku,
                    Artículo: r.name,
                    Categoría: r.category ?? '',
                    Existencia: r.qty,
                    'Costo promedio': r.avgCost,
                    Valor: r.value,
                    'Precio de venta': r.price,
                  })));
                }}
              >
                Valuación
              </Button>
            )}
          </>
        }
      />

      <div className="toolbar">
        <SearchInput
          compact
          value={search}
          placeholder="SKU, nombre o código de barras…"
          aria-label="Buscar en inventario"
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} />
          Solo bajo el mínimo
        </label>
        <span className="toolbar__spacer" />
        {showCost && rows.length > 0 && (
          <span className="muted">
            Valor mostrado: <strong>{formatMoney(totalValue)}</strong>
          </span>
        )}
      </div>

      {stock.error && <Alert>{stock.error}</Alert>}
      {stock.data && rows.length === 0 && (
        <Card>
          <EmptyState icon="box" title={onlyLow ? 'Nada está bajo su mínimo' : 'Sin artículos'} />
        </Card>
      )}

      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Artículo</th>
                <th>Categoría</th>
                <th className="table__num">Existencia</th>
                <th className="table__num">Disponible</th>
                <th className="table__num">Mínimo</th>
                <th className="table__money">Precio</th>
                {showCost && <th className="table__money">Valor</th>}
                <th>Último mov.</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.variantId}>
                  <td>
                    {r.name}
                    <div className="mono subtle text-sm">{r.sku}</div>
                  </td>
                  <td className="muted">{r.category?.name ?? '—'}</td>
                  <td className="table__num">
                    <strong>{formatQty(r.qtyOnHand)}</strong>
                    {r.isOut && <Badge tone="danger">Agotado</Badge>}
                    {r.isLow && !r.isOut && <Badge tone="warning">Bajo</Badge>}
                  </td>
                  <td className="table__num">{formatQty(r.qtyAvailable)}</td>
                  <td className="table__num muted">{r.minStock ? formatQty(r.minStock) : '—'}</td>
                  <td className="table__money">{formatMoney(r.price)}</td>
                  {showCost && <td className="table__money">{formatMoney(r.stockValue ?? 0)}</td>}
                  <td className="muted text-sm">{r.lastMovementAt ? formatDateTime(r.lastMovementAt) : '—'}</td>
                  <td className="cell-actions">
                    {canKardex && (
                      <Button size="sm" variant="subtle" icon="list" onClick={() => setKardexOf(r)}>
                        Kardex
                      </Button>
                    )}
                    {canAdjust && (
                      <Button size="sm" variant="subtle" icon="edit" onClick={() => setAdjusting([r])}>
                        Ajustar
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {kardexOf && <KardexDialog row={kardexOf} showCost={showCost} onClose={() => setKardexOf(null)} />}
      {adjusting && (
        <AdjustDialog
          initial={adjusting}
          onClose={() => setAdjusting(null)}
          onDone={() => {
            setAdjusting(null);
            void stock.reload();
          }}
        />
      )}
    </div>
  );
}

function KardexDialog({ row, showCost, onClose }: { row: StockRow; showCost: boolean; onClose: () => void }) {
  const { data, error } = useLoad(() => api.kardex(row.variantId, { limit: 300 }), [row.variantId]);
  return (
    <Modal
      label="Kardex"
      wide
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      head={
        <>
          <h2 className="modal__title">
            Kardex · {row.name} <span className="mono subtle text-sm">{row.sku}</span>
          </h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
      foot={
        data && (
          <div className="modal__actions">
            <Button
              variant="secondary"
              icon="download"
              onClick={() =>
                downloadCsv(`kardex-${row.sku}.csv`, data.movements.map((m) => ({
                  Fecha: new Date(m.occurredAt).toLocaleString('es-MX'),
                  Movimiento: MOVEMENT_LABELS[m.movementType] ?? m.movementType,
                  Anterior: m.qtyBefore,
                  Entrada: m.direction === 'IN' ? m.qty : '',
                  Salida: m.direction === 'OUT' ? m.qty : '',
                  Resultante: m.qtyAfter,
                  ...(showCost ? { 'Costo unitario': m.unitCost ?? '' } : {}),
                  Referencia: m.reference ?? '',
                  Motivo: m.reasonCode ?? '',
                  Usuario: m.user?.name ?? '',
                })))
              }
            >
              Exportar kardex
            </Button>
          </div>
        )
      }
    >
      {error && <Alert>{error}</Alert>}
      {!data && !error && <p className="subtle">Cargando…</p>}
      {data && data.movements.length === 0 && <EmptyState icon="list" title="Sin movimientos" />}
      {data && data.movements.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Movimiento</th>
              <th className="table__num">Anterior</th>
              <th className="table__num">Entrada</th>
              <th className="table__num">Salida</th>
              <th className="table__num">Resultante</th>
              {showCost && <th className="table__money">Costo</th>}
              <th>Referencia</th>
              <th>Usuario</th>
            </tr>
          </thead>
          <tbody>
            {data.movements.map((m) => (
              <tr key={m.id}>
                <td className="tnum text-sm">{formatDateTime(m.occurredAt)}</td>
                <td>
                  {MOVEMENT_LABELS[m.movementType] ?? m.movementType}
                  {m.reasonCode && <div className="subtle text-sm">{m.reasonCode}</div>}
                </td>
                <td className="table__num muted">{formatQty(m.qtyBefore)}</td>
                <td className="table__num" style={{ color: 'var(--positive)' }}>
                  {m.direction === 'IN' ? `+${formatQty(m.qty)}` : ''}
                </td>
                <td className="table__num" style={{ color: 'var(--danger)' }}>
                  {m.direction === 'OUT' ? `−${formatQty(m.qty)}` : ''}
                </td>
                <td className="table__num">
                  <strong>{formatQty(m.qtyAfter)}</strong>
                </td>
                {showCost && <td className="table__money">{m.unitCost ? formatMoney(m.unitCost) : '—'}</td>}
                <td className="mono text-sm">{m.reference ?? '—'}</td>
                <td className="text-sm">{m.user?.name ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function AdjustDialog({
  initial,
  onClose,
  onDone,
}: {
  initial: StockRow[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [lines, setLines] = useState(
    initial.map((r) => ({ variantId: r.variantId, name: r.name, sku: r.sku, current: Number(r.qtyOnHand), counted: String(Number(r.qtyOnHand)) })),
  );
  const [reason, setReason] = useState(ADJUST_REASONS[0]!.code);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const response = await api.adjustStock({
        lines: lines.map((l) => ({ variantId: l.variantId, countedQty: l.counted || '0' })),
        reasonCode: reason,
        notes: notes || undefined,
      });
      setResult(`Ajuste ${response.folio} aplicado.`);
      setTimeout(onDone, 900);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      label="Ajustar inventario"
      wide
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      head={
        <>
          <h2 className="modal__title">Ajustar inventario</h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
      foot={
        <div className="modal__actions">
          <Button variant="subtle" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={busy || lines.length === 0} onClick={save}>
            {busy ? 'Aplicando…' : `Aplicar ajuste (${lines.length})`}
          </Button>
        </div>
      }
    >
      <p className="field__hint">
        Escribe la cantidad que CONTASTE. El sistema calcula la diferencia y la registra en el kardex
        con el motivo. Las entradas por ajuste se valúan al costo promedio actual: para cargar
        mercancía nueva con su costo real usa <strong>Compras → Recepción directa</strong>.
      </p>
      <VariantPicker
        autoFocus={initial.length === 0}
        placeholder="Agregar artículo al ajuste…"
        onPick={(item) =>
          setLines((rows) =>
            rows.some((r) => r.variantId === item.variantId)
              ? rows
              : [...rows, { variantId: item.variantId, name: item.name, sku: item.sku, current: Number(item.qtyAvailable), counted: '' }],
          )
        }
      />
      {lines.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Artículo</th>
              <th className="table__num">En sistema</th>
              <th className="table__num">Contado</th>
              <th className="table__num">Diferencia</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const diff = Number(l.counted || 0) - l.current;
              return (
                <tr key={l.variantId}>
                  <td>
                    {l.name}
                    <div className="mono subtle text-sm">{l.sku}</div>
                  </td>
                  <td className="table__num">{formatQty(l.current)}</td>
                  <td className="table__num">
                    <TextInput
                      className="input--sm num-input"
                      inputMode="decimal"
                      value={l.counted}
                      onChange={(e) =>
                        setLines((rows) => rows.map((r, j) => (j === i ? { ...r, counted: e.target.value.replace(/[^\d.]/g, '') } : r)))
                      }
                    />
                  </td>
                  <td className="table__num" style={{ color: diff > 0 ? 'var(--positive)' : diff < 0 ? 'var(--danger)' : undefined }}>
                    {diff > 0 ? '+' : ''}
                    {formatQty(diff)}
                  </td>
                  <td>
                    <Button size="sm" variant="subtle" icon="trash" aria-label="Quitar" onClick={() => setLines((rows) => rows.filter((_, j) => j !== i))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="form-grid">
        <Field label="Motivo" htmlFor="adj-reason">
          <Select id="adj-reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            {ADJUST_REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notas" htmlFor="adj-notes">
          <TextInput id="adj-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
      </div>
      {result && <p className="toast">{result}</p>}
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}
