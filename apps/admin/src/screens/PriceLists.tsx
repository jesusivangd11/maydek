import { useState } from 'react';
import { api, type PriceList } from '@pos/lib/api';
import { formatMoney, formatQty, toNumber } from '@pos/lib/format';
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeader, TextInput } from '@pos/ui';
import type { ScreenProps } from '../App';
import { VariantPicker } from '../components/VariantPicker';
import { can, errorText, useLoad } from '../lib/util';

/**
 * Listas de precios.
 *
 * Público, mayoreo, distribuidor, especial. Un artículo sin precio en la
 * lista se vende a su precio de mostrador. "A partir de" permite precio por
 * volumen: 1 pieza a $500, 12 o más a $420.
 */
export function PriceListsScreen({ user }: ScreenProps) {
  const lists = useLoad(() => api.priceLists(), []);
  const [selected, setSelected] = useState<PriceList | null>(null);
  const active = selected ?? lists.data?.find((l) => l.code === 'MAYOREO') ?? lists.data?.[0] ?? null;

  return (
    <div className="page">
      <PageHeader title="Listas de precios" subtitle="Precios de mayoreo, distribuidor y por volumen." />
      {lists.error && <Alert>{lists.error}</Alert>}
      <div className="grid-2" style={{ gridTemplateColumns: 'minmax(220px, 0.6fr) minmax(0, 2fr)' }}>
        <Card title="Listas" flush>
          <ul className="pick-list" style={{ padding: 'var(--s-3)', maxHeight: 'none' }}>
            {lists.data?.map((l) => (
              <li key={l.id}>
                <button type="button" className="pick-list__item" aria-selected={active?.id === l.id} onClick={() => setSelected(l)}>
                  <span className="pick-list__main">
                    <strong>{l.name}</strong>
                    <span className="subtle text-sm">
                      {l.itemCount} precios · {l.customerCount} clientes
                    </span>
                  </span>
                  {!l.isActive && <Badge>Inactiva</Badge>}
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {active && (
          <ListItems
            key={active.id}
            list={active}
            canManage={can(user.permissions, 'pricing.list.manage')}
            onChanged={lists.reload}
          />
        )}
      </div>
    </div>
  );
}

function ListItems({ list, canManage, onChanged }: { list: PriceList; canManage: boolean; onChanged: () => void }) {
  const items = useLoad(() => api.priceListItems(list.id), [list.id]);
  const [pending, setPending] = useState<{ variantId: string; name: string; basePrice: string } | null>(null);
  const [price, setPrice] = useState('');
  const [minQty, setMinQty] = useState('1');
  const [error, setError] = useState<string | null>(null);

  async function save(variantId: string, value: string, qty: string) {
    setError(null);
    try {
      items.setData(await api.setPriceListItem(list.id, { variantId, price: Number(value).toFixed(2), minQty: qty || '1' }));
      setPending(null);
      setPrice('');
      setMinQty('1');
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Card title={`Precios · ${list.name}`} flush>
      <div style={{ padding: 'var(--s-4)' }} className="stack">
        {canManage && (
          <>
            <VariantPicker
              placeholder="Agregar artículo a la lista…"
              onPick={(item) => {
                setPending({ variantId: item.variantId, name: item.name, basePrice: item.unitPrice });
                setPrice(toNumber(item.unitPrice).toFixed(2));
              }}
            />
            {pending && (
              <div className="form-grid form-grid--3" style={{ alignItems: 'end' }}>
                <p className="field--wide" style={{ margin: 0 }}>
                  <strong>{pending.name}</strong> · mostrador {formatMoney(pending.basePrice)}
                </p>
                <Field label={`Precio en ${list.name}`} htmlFor="pl-price">
                  <TextInput id="pl-price" autoFocus inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))} />
                </Field>
                <Field label="A partir de (piezas)" htmlFor="pl-min">
                  <TextInput id="pl-min" inputMode="decimal" value={minQty} onChange={(e) => setMinQty(e.target.value.replace(/[^\d.]/g, ''))} />
                </Field>
                <Button variant="primary" disabled={!(Number(price) >= 0) || price === ''} onClick={() => save(pending.variantId, price, minQty)}>
                  Guardar precio
                </Button>
              </div>
            )}
          </>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
      {items.data?.length === 0 && (
        <EmptyState icon="tag" title="Esta lista no tiene precios propios" text="Los artículos se venden a su precio de mostrador." />
      )}
      {items.data && items.data.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Artículo</th>
              <th className="table__num">Desde</th>
              <th className="table__money">Mostrador</th>
              <th className="table__money">Precio lista</th>
              <th className="table__num">Desc.</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.data.map((i) => {
              const base = toNumber(i.basePrice);
              const pct = base > 0 ? ((base - toNumber(i.price)) / base) * 100 : 0;
              return (
                <tr key={i.id}>
                  <td>
                    {i.name}
                    <div className="mono subtle text-sm">{i.sku}</div>
                  </td>
                  <td className="table__num">{formatQty(i.minQty)} pzas</td>
                  <td className="table__money muted">{formatMoney(i.basePrice)}</td>
                  <td className="table__money table__money--strong">{formatMoney(i.price)}</td>
                  <td className="table__num">{pct.toFixed(0)} %</td>
                  <td className="cell-actions">
                    {canManage && (
                      <Button
                        size="sm"
                        variant="subtle"
                        icon="trash"
                        aria-label="Quitar precio"
                        onClick={async () => {
                          items.setData(await api.removePriceListItem(list.id, i.id));
                          onChanged();
                        }}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
