import { useMemo, useState } from 'react';
import {
  api,
  type CatalogOptions,
  type Category,
  type ProductDetail,
  type ProductInput,
  type ProductRow,
} from '@pos/lib/api';
import { formatMoney } from '@pos/lib/format';
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
  Segmented,
  Select,
  TextInput,
} from '@pos/ui';
import type { ScreenProps } from '../App';
import { can, downloadCsv, errorText, useLoad } from '../lib/util';

/**
 * Productos.
 *
 * Lo que se vende es la VARIANTE (Faja · Negro / M), no el producto. El alta
 * genera las variantes por combinación de opciones: "Color: Negro, Beige" ×
 * "Talla: S, M, L, XL" son 8 variantes con SKU en un solo paso. Un producto
 * sin opciones lleva una sola variante implícita y se ve como simple.
 *
 * Nunca se borra un producto: se desactiva. Un ticket viejo que lo menciona
 * tiene que seguir abriendo.
 */
export function ProductsScreen({ user }: ScreenProps) {
  const [tab, setTab] = useState<'products' | 'categories'>('products');
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<string | 'new' | null>(null);

  const categories = useLoad(() => api.listCategories(true), []);
  const options = useLoad(() => api.catalogOptions(), []);
  const products = useLoad(
    () =>
      api.listProducts({
        search: search || undefined,
        categoryId: categoryId || undefined,
        includeInactive: showInactive || undefined,
        limit: 200,
      }),
    [search, categoryId, showInactive],
  );

  const canCreate = can(user.permissions, 'product.create');
  const showCost = can(user.permissions, 'product.cost.view');

  return (
    <div className="page">
      <PageHeader
        title="Productos"
        subtitle="Catálogo, variantes, precios y códigos de barras."
        actions={
          canCreate && (
            <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
              Nuevo producto
            </Button>
          )
        }
      />

      <div className="tabs" role="tablist">
        <button className="tabs__item" role="tab" aria-selected={tab === 'products'} onClick={() => setTab('products')}>
          Productos
        </button>
        <button className="tabs__item" role="tab" aria-selected={tab === 'categories'} onClick={() => setTab('categories')}>
          Categorías
        </button>
      </div>

      {tab === 'categories' ? (
        <CategoriesPanel
          categories={categories.data ?? []}
          canManage={can(user.permissions, 'category.manage')}
          onChanged={categories.reload}
        />
      ) : (
        <>
          <div className="toolbar">
            <SearchInput
              compact
              value={search}
              placeholder="Nombre o SKU…"
              aria-label="Buscar productos"
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Categoría">
              <option value="">Todas las categorías</option>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <label className="check">
              <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
              Ver desactivados
            </label>
            <span className="toolbar__spacer" />
            <Button
              variant="subtle"
              icon="download"
              disabled={!products.data?.data.length}
              onClick={() =>
                downloadCsv(
                  'catalogo.csv',
                  (products.data?.data ?? []).flatMap((p) =>
                    p.variants.map((v) => ({
                      Producto: p.name,
                      Variante: v.nameSuffix ?? '',
                      SKU: v.sku,
                      'Código de barras': v.barcode ?? '',
                      Categoría: p.category?.name ?? '',
                      Precio: v.basePrice,
                      ...(showCost ? { Costo: v.cost ?? '' } : {}),
                      Mínimo: v.minStock ?? '',
                      Activo: p.isActive && v.isActive ? 'Sí' : 'No',
                    })),
                  ),
                )
              }
            >
              Exportar
            </Button>
          </div>

          {products.error && <Alert>{products.error}</Alert>}

          {products.data && products.data.data.length === 0 && (
            <Card>
              <EmptyState
                icon="box"
                title="No hay productos que mostrar"
                text={search ? 'Prueba con otro nombre o SKU.' : 'Da de alta el primero con «Nuevo producto».'}
              />
            </Card>
          )}

          {products.data && products.data.data.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Producto</th>
                    <th>Categoría</th>
                    <th>Variantes</th>
                    <th className="table__money">Precio</th>
                    {showCost && <th className="table__money">Costo</th>}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {products.data.data.map((p) => (
                    <ProductRowView key={p.id} product={p} showCost={showCost} onOpen={() => setEditing(p.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {editing === 'new' && options.data && (
        <NewProductDialog
          options={options.data}
          categories={categories.data ?? []}
          onClose={() => setEditing(null)}
          onCreated={(product) => {
            void products.reload();
            setEditing(product.id);
          }}
        />
      )}
      {editing && editing !== 'new' && (
        <EditProductDialog
          productId={editing}
          options={options.data}
          categories={categories.data ?? []}
          permissions={user.permissions}
          onClose={() => {
            setEditing(null);
            void products.reload();
          }}
        />
      )}
    </div>
  );
}

function ProductRowView({
  product,
  showCost,
  onOpen,
}: {
  product: ProductRow;
  showCost: boolean;
  onOpen: () => void;
}) {
  const prices = product.variants.map((v) => Number(v.basePrice));
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return (
    <tr className="table__row--clickable" tabIndex={0} onClick={onOpen} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <td>
        <strong>{product.name}</strong>
        <div className="mono subtle text-sm">
          {product.hasVariants ? product.variants.map((v) => v.sku).slice(0, 3).join(', ') : product.variants[0]?.sku}
          {product.variants.length > 3 ? '…' : ''}
        </div>
      </td>
      <td className="muted">{product.category?.name ?? '—'}</td>
      <td>
        {product.hasVariants ? `${product.variants.length} variantes` : 'Simple'}
        {!product.trackStock && <Badge dot={false}>Servicio</Badge>}
        {!product.isActive && <Badge tone="danger">Desactivado</Badge>}
      </td>
      <td className="table__money">
        {min === max ? formatMoney(min) : `${formatMoney(min)} – ${formatMoney(max)}`}
      </td>
      {showCost && <td className="table__money muted">{formatMoney(product.variants[0]?.cost ?? 0)}</td>}
      <td className="cell-actions">
        <Button size="sm" variant="subtle" icon="edit">
          Editar
        </Button>
      </td>
    </tr>
  );
}

// ── Alta ────────────────────────────────────────────────────────────────────

interface DraftVariant {
  nameSuffix: string;
  sku: string;
  basePrice: string;
  barcode: string;
  stock: string;
}

/** Solo dígitos y punto: lo que se captura en un campo de importe o cantidad. */
const decimal = (value: string) => value.replace(/[^\d.]/g, '');

/** Margen sobre el precio sin IVA, que es como lo calcula el reporte de utilidad. */
function margin(price: string, cost: string, taxRate: number): string | null {
  const net = Number(price) / (1 + taxRate);
  if (!(Number(cost) > 0) || !(net > 0)) return null;
  return `Ganancia ${(((net - Number(cost)) / net) * 100).toFixed(0)} % (sin IVA)`;
}

function slug(text: string, length = 3): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .slice(0, length);
}

function NewProductDialog({
  options,
  categories,
  onClose,
  onCreated,
}: {
  options: CatalogOptions;
  categories: Category[];
  onClose: () => void;
  onCreated: (product: ProductDetail) => void;
}) {
  const defaultTax = options.taxRates.find((t) => t.isDefault) ?? options.taxRates[0];
  const [mode, setMode] = useState<'simple' | 'variants'>('simple');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [wholesale, setWholesale] = useState('');
  const [stock, setStock] = useState('');
  const [minStock, setMinStock] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [unitId, setUnitId] = useState(options.units.find((u) => u.code === 'PZA')?.id ?? options.units[0]?.id ?? '');
  const [taxRateId, setTaxRateId] = useState(defaultTax?.id ?? '');
  const [trackStock, setTrackStock] = useState(true);
  const [optionA, setOptionA] = useState('Negro, Beige');
  const [optionB, setOptionB] = useState('S, M, L, XL');
  const [variants, setVariants] = useState<DraftVariant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taxRate = Number(options.taxRates.find((t) => t.id === taxRateId)?.rate ?? 0);

  function generate() {
    const a = optionA.split(',').map((s) => s.trim()).filter(Boolean);
    const b = optionB.split(',').map((s) => s.trim()).filter(Boolean);
    const base = sku.trim() || slug(name, 6) || 'PROD';
    const combos = a.length && b.length ? a.flatMap((x) => b.map((y) => [x, y])) : (a.length ? a : b).map((x) => [x]);
    setVariants(
      combos.map((parts) => ({
        nameSuffix: parts.join(' / '),
        sku: [base, ...parts.map((p) => slug(p))].join('-'),
        basePrice: price,
        barcode: '',
        stock: '',
      })),
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    const body: ProductInput = {
      name: name.trim(),
      description: description.trim() || undefined,
      categoryId: categoryId || undefined,
      unitId: unitId || undefined,
      taxRateId: taxRateId || undefined,
      trackStock,
      ...(mode === 'simple'
        ? {
            sku: sku.trim(),
            barcode: barcode.trim() || undefined,
            basePrice: price || '0',
            minStock: minStock || undefined,
            cost: cost || undefined,
            wholesalePrice: wholesale || undefined,
            initialStock: trackStock && stock ? stock : undefined,
          }
        : {
            variants: variants.map((v) => ({
              sku: v.sku.trim(),
              nameSuffix: v.nameSuffix.trim() || undefined,
              basePrice: v.basePrice || price || '0',
              barcode: v.barcode.trim() || undefined,
              minStock: minStock || undefined,
              cost: cost || undefined,
              wholesalePrice: wholesale || undefined,
              initialStock: trackStock && v.stock ? v.stock : undefined,
            })),
          }),
    };
    try {
      onCreated(await api.createProduct(body));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const invalid =
    name.trim().length < 2 ||
    (mode === 'simple' ? !sku.trim() : variants.length === 0 || variants.some((v) => !v.sku.trim()));

  return (
    <Modal
      label="Nuevo producto"
      wide
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      head={
        <>
          <h2 className="modal__title">Nuevo producto</h2>
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
          <Button variant="primary" disabled={busy || invalid} onClick={save}>
            {busy ? 'Guardando…' : mode === 'variants' ? `Crear con ${variants.length} variantes` : 'Crear producto'}
          </Button>
        </div>
      }
    >
      <div className="form-grid">
        <div className="field--wide">
          <Field label="Nombre" htmlFor="p-name">
            <TextInput id="p-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Faja postquirúrgica Modelo X" />
          </Field>
        </div>
        <Field label="Categoría" htmlFor="p-cat">
          <Select id="p-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Sin categoría</option>
            {categories.filter((c) => c.isActive).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Unidad" htmlFor="p-unit">
          <Select id="p-unit" value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            {options.units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.code})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Impuesto" htmlFor="p-tax">
          <Select id="p-tax" value={taxRateId} onChange={(e) => setTaxRateId(e.target.value)}>
            {options.taxRates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Costo (por pieza, sin IVA)" htmlFor="p-cost" hint="Lo que te cuesta. Sirve para la utilidad.">
          <TextInput id="p-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(decimal(e.target.value))} placeholder="0.00" />
        </Field>
        <Field
          label="Precio de venta (con IVA)"
          htmlFor="p-price"
          hint={margin(price, cost, taxRate) ?? undefined}
        >
          <TextInput id="p-price" inputMode="decimal" value={price} onChange={(e) => setPrice(decimal(e.target.value))} placeholder="0.00" />
        </Field>
        <Field label="Precio de mayoreo" htmlFor="p-wholesale" hint="El que aplica la tecla F11 en la caja.">
          <TextInput id="p-wholesale" inputMode="decimal" value={wholesale} onChange={(e) => setWholesale(decimal(e.target.value))} placeholder="Opcional" />
        </Field>
        {mode === 'simple' && trackStock && (
          <Field label="Existencia inicial" htmlFor="p-stock" hint="Lo que tienes hoy en el anaquel.">
            <TextInput id="p-stock" inputMode="decimal" value={stock} onChange={(e) => setStock(decimal(e.target.value))} placeholder="0" />
          </Field>
        )}
        <Field label="Existencia mínima" htmlFor="p-min" hint="Avisa cuando quede esto o menos.">
          <TextInput id="p-min" inputMode="decimal" value={minStock} onChange={(e) => setMinStock(decimal(e.target.value))} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={!trackStock} onChange={(e) => setTrackStock(!e.target.checked)} />
          Es un servicio (no lleva inventario)
        </label>
      </div>

      <Segmented
        block
        label="Tipo de producto"
        value={mode}
        onChange={setMode}
        options={[
          { value: 'simple', label: 'Producto simple' },
          { value: 'variants', label: 'Con variantes (tallas, colores…)' },
        ]}
      />

      {mode === 'simple' ? (
        <div className="form-grid">
          <Field label="SKU" htmlFor="p-sku">
            <TextInput id="p-sku" value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} placeholder="FJ-001" />
          </Field>
          <Field label="Código de barras" htmlFor="p-barcode" hint="Escanéalo con el lector.">
            <TextInput id="p-barcode" value={barcode} onChange={(e) => setBarcode(e.target.value)} />
          </Field>
        </div>
      ) : (
        <>
          <div className="form-grid">
            <Field label="SKU base" htmlFor="p-skubase">
              <TextInput id="p-skubase" value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} placeholder="FJ-X" />
            </Field>
            <Field label="Opción 1 (ej. colores)" htmlFor="p-oa">
              <TextInput id="p-oa" value={optionA} onChange={(e) => setOptionA(e.target.value)} />
            </Field>
            <Field label="Opción 2 (ej. tallas)" htmlFor="p-ob">
              <TextInput id="p-ob" value={optionB} onChange={(e) => setOptionB(e.target.value)} />
            </Field>
          </div>
          <Button variant="secondary" icon="list" onClick={generate} disabled={!name.trim()}>
            Generar variantes
          </Button>
          {variants.length > 0 && (
            <table className="table">
              <thead>
                <tr>
                  <th>Variante</th>
                  <th>SKU</th>
                  <th>Código de barras</th>
                  <th className="table__money">Precio</th>
                  {trackStock && <th className="table__num">Existencia</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {variants.map((v, i) => {
                  const update = (patch: Partial<DraftVariant>) =>
                    setVariants((rows) => rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));
                  return (
                    <tr key={i}>
                      <td>
                        <TextInput className="input--sm" value={v.nameSuffix} onChange={(e) => update({ nameSuffix: e.target.value })} />
                      </td>
                      <td>
                        <TextInput className="input--sm mono" value={v.sku} onChange={(e) => update({ sku: e.target.value.toUpperCase() })} />
                      </td>
                      <td>
                        <TextInput className="input--sm" value={v.barcode} onChange={(e) => update({ barcode: e.target.value })} />
                      </td>
                      <td>
                        <TextInput className="input--sm num-input" inputMode="decimal" value={v.basePrice} onChange={(e) => update({ basePrice: decimal(e.target.value) })} />
                      </td>
                      {trackStock && (
                        <td>
                          <TextInput className="input--sm num-input" inputMode="decimal" value={v.stock} placeholder="0" onChange={(e) => update({ stock: decimal(e.target.value) })} />
                        </td>
                      )}
                      <td>
                        <Button size="sm" variant="subtle" icon="trash" aria-label="Quitar" onClick={() => setVariants((rows) => rows.filter((_, j) => j !== i))} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}

      <Field label="Descripción" htmlFor="p-desc">
        <TextInput id="p-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <p className="field__hint">
        La existencia inicial queda en el kárdex como «carga inicial», al costo capturado. Después, las
        entradas se registran con compras o ajustes de inventario.
      </p>
      {error && <Alert>{error}</Alert>}
    </Modal>
  );
}

// ── Edición ─────────────────────────────────────────────────────────────────

function EditProductDialog({
  productId,
  options,
  categories,
  permissions,
  onClose,
}: {
  productId: string;
  options: CatalogOptions | null;
  categories: Category[];
  permissions: string[];
  onClose: () => void;
}) {
  const { data: product, error, setData } = useLoad(() => api.getProduct(productId), [productId]);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const canEdit = can(permissions, 'product.update');
  const canPrice = can(permissions, 'product.price.update');
  const showCost = can(permissions, 'product.cost.view');

  async function run(label: string, action: () => Promise<ProductDetail>) {
    setSaving(label);
    setFailure(null);
    setMessage(null);
    try {
      setData(await action());
      setMessage('Cambios guardados.');
    } catch (err) {
      setFailure(errorText(err));
    } finally {
      setSaving(null);
    }
  }

  return (
    <Modal
      label="Editar producto"
      wide
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      head={
        <>
          <h2 className="modal__title">{product?.name ?? 'Producto'}</h2>
          <Button variant="subtle" icon="close" onClick={onClose}>
            Cerrar
          </Button>
        </>
      }
      foot={
        product && (
          <div className="modal__actions">
            {can(permissions, 'product.archive') && (
              <Button
                variant={product.isActive ? 'danger' : 'secondary'}
                disabled={Boolean(saving)}
                onClick={() => run('active', () => api.setProductActive(product.id, !product.isActive))}
              >
                {product.isActive ? 'Desactivar producto' : 'Reactivar producto'}
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Listo
            </Button>
          </div>
        )
      }
    >
      {error && <Alert>{error}</Alert>}
      {!product && !error && <p className="subtle">Cargando…</p>}
      {product && (
        <>
          <ProductFields
            product={product}
            options={options}
            categories={categories}
            disabled={!canEdit || Boolean(saving)}
            onSave={(patch) => run('product', () => api.updateProduct(product.id, patch))}
          />
          <h3 className="section-label">Variantes</h3>
          <div className="table-wrap">
          <table className="table variant-table">
            <thead>
              <tr>
                <th>Variante</th>
                <th>SKU</th>
                <th>Código de barras</th>
                <th className="table__money">Precio</th>
                <th className="table__money">Mayoreo</th>
                <th className="table__num">Mínimo</th>
                {showCost && <th className="table__money">Costo prom.</th>}
                <th className="table__num">Existencia</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {product.variants.map((v) => (
                <VariantEditor
                  key={`${v.id}-${v.basePrice}-${v.wholesalePrice ?? ''}-${v.sku}`}
                  variant={v}
                  showCost={showCost}
                  canEdit={canEdit}
                  canPrice={canPrice}
                  busy={saving === v.id}
                  onSave={(patch) => run(v.id, () => api.updateVariant(v.id, patch))}
                />
              ))}
            </tbody>
          </table>
          </div>
          {canEdit && <AddVariantRow onAdd={(body) => run('add', () => api.addVariant(product.id, body))} />}
        </>
      )}
      {message && <p className="toast">{message}</p>}
      {failure && <Alert>{failure}</Alert>}
    </Modal>
  );
}

function ProductFields({
  product,
  options,
  categories,
  disabled,
  onSave,
}: {
  product: ProductDetail;
  options: CatalogOptions | null;
  categories: Category[];
  disabled: boolean;
  onSave: (patch: { name?: string; description?: string; categoryId?: string; taxRateId?: string; trackStock?: boolean }) => void;
}) {
  const [name, setName] = useState(product.name);
  const [description, setDescription] = useState(product.description ?? '');
  const [categoryId, setCategoryId] = useState(product.category?.id ?? '');
  const [taxRateId, setTaxRateId] = useState(product.taxRate?.id ?? '');
  const dirty =
    name !== product.name ||
    description !== (product.description ?? '') ||
    categoryId !== (product.category?.id ?? '') ||
    taxRateId !== (product.taxRate?.id ?? '');

  return (
    <div className="form-grid">
      <Field label="Nombre" htmlFor="e-name">
        <TextInput id="e-name" value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Categoría" htmlFor="e-cat">
        <Select id="e-cat" value={categoryId} disabled={disabled} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">Sin categoría</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Impuesto" htmlFor="e-tax">
        <Select id="e-tax" value={taxRateId} disabled={disabled} onChange={(e) => setTaxRateId(e.target.value)}>
          {options?.taxRates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Descripción" htmlFor="e-desc">
        <TextInput id="e-desc" value={description} disabled={disabled} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="field--wide" style={{ display: 'flex', gap: 'var(--s-3)', alignItems: 'center' }}>
        {!product.isActive && <Badge tone="danger">Desactivado</Badge>}
        {!product.trackStock && <Badge dot={false}>Servicio sin inventario</Badge>}
        <span className="toolbar__spacer" />
        <Button
          variant="secondary"
          disabled={disabled || !dirty || name.trim().length < 2}
          onClick={() =>
            onSave({
              name: name.trim(),
              description,
              ...(categoryId ? { categoryId } : {}),
              ...(taxRateId ? { taxRateId } : {}),
            })
          }
        >
          Guardar datos del producto
        </Button>
      </div>
    </div>
  );
}

function VariantEditor({
  variant,
  showCost,
  canEdit,
  canPrice,
  busy,
  onSave,
}: {
  variant: ProductDetail['variants'][number];
  showCost: boolean;
  canEdit: boolean;
  canPrice: boolean;
  busy: boolean;
  onSave: (patch: {
    sku?: string;
    nameSuffix?: string;
    basePrice?: string;
    wholesalePrice?: string;
    minStock?: string;
    barcode?: string;
    isActive?: boolean;
  }) => void;
}) {
  const primary = variant.barcodes.find((b) => b.isPrimary)?.code ?? variant.barcodes[0]?.code ?? '';
  const initialWholesale = variant.wholesalePrice ? Number(variant.wholesalePrice).toFixed(2) : '';
  const [sku, setSku] = useState(variant.sku);
  const [suffix, setSuffix] = useState(variant.nameSuffix ?? '');
  const [barcode, setBarcode] = useState(primary);
  const [price, setPrice] = useState(Number(variant.basePrice).toFixed(2));
  const [wholesale, setWholesale] = useState(initialWholesale);
  const [min, setMin] = useState(variant.minStock ? String(Number(variant.minStock)) : '');
  const stock = variant.stock.reduce((acc, s) => acc + Number(s.qtyOnHand), 0);

  const patch = useMemo(() => {
    const out: Record<string, string> = {};
    if (sku !== variant.sku) out.sku = sku;
    if (suffix !== (variant.nameSuffix ?? '')) out.nameSuffix = suffix;
    if (barcode !== primary) out.barcode = barcode;
    if (Number(price) !== Number(variant.basePrice)) out.basePrice = price;
    if (wholesale !== initialWholesale) out.wholesalePrice = wholesale;
    if (min !== (variant.minStock ? String(Number(variant.minStock)) : '')) out.minStock = min;
    return out;
  }, [sku, suffix, barcode, price, wholesale, initialWholesale, min, variant, primary]);

  return (
    <tr style={variant.isActive ? undefined : { opacity: 0.55 }}>
      <td>
        <TextInput className="input--sm" value={suffix} disabled={!canEdit} placeholder="—" onChange={(e) => setSuffix(e.target.value)} />
      </td>
      <td>
        <TextInput className="input--sm mono" value={sku} disabled={!canEdit} onChange={(e) => setSku(e.target.value.toUpperCase())} />
      </td>
      <td>
        <TextInput className="input--sm" value={barcode} disabled={!canEdit} onChange={(e) => setBarcode(e.target.value)} />
      </td>
      <td>
        <TextInput
          className="input--sm num-input"
          inputMode="decimal"
          value={price}
          disabled={!canPrice}
          title={canPrice ? undefined : 'Cambiar precios requiere el permiso product.price.update'}
          onChange={(e) => setPrice(decimal(e.target.value))}
        />
      </td>
      <td>
        <TextInput
          className="input--sm num-input"
          inputMode="decimal"
          value={wholesale}
          placeholder="—"
          disabled={!canPrice}
          title="Precio de mayoreo (F11). Vacío: sin precio de mayoreo."
          onChange={(e) => setWholesale(decimal(e.target.value))}
        />
      </td>
      <td>
        <TextInput className="input--sm num-input" inputMode="decimal" value={min} disabled={!canEdit} onChange={(e) => setMin(e.target.value.replace(/[^\d.]/g, ''))} />
      </td>
      {showCost && <td className="table__money muted">{formatMoney(variant.cost ?? 0)}</td>}
      <td className="table__num">{stock}</td>
      <td className="cell-actions">
        <Button size="sm" variant="primary" disabled={busy || Object.keys(patch).length === 0} onClick={() => onSave(patch)}>
          {busy ? '…' : 'Guardar'}
        </Button>
        {canEdit && (
          <Button size="sm" variant="subtle" disabled={busy} onClick={() => onSave({ isActive: !variant.isActive })}>
            {variant.isActive ? 'Desactivar' : 'Activar'}
          </Button>
        )}
      </td>
    </tr>
  );
}

function AddVariantRow({
  onAdd,
}: {
  onAdd: (body: { sku: string; nameSuffix?: string; basePrice?: string; barcode?: string }) => void;
}) {
  const [sku, setSku] = useState('');
  const [suffix, setSuffix] = useState('');
  const [price, setPrice] = useState('');
  const [barcode, setBarcode] = useState('');
  return (
    <div className="form-grid form-grid--3" style={{ alignItems: 'end' }}>
      <Field label="Nueva variante" htmlFor="nv-suffix">
        <TextInput id="nv-suffix" value={suffix} placeholder="Rojo / XL" onChange={(e) => setSuffix(e.target.value)} />
      </Field>
      <Field label="SKU" htmlFor="nv-sku">
        <TextInput id="nv-sku" value={sku} onChange={(e) => setSku(e.target.value.toUpperCase())} />
      </Field>
      <Field label="Precio" htmlFor="nv-price">
        <TextInput id="nv-price" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))} />
      </Field>
      <Field label="Código de barras" htmlFor="nv-bar">
        <TextInput id="nv-bar" value={barcode} onChange={(e) => setBarcode(e.target.value)} />
      </Field>
      <Button
        variant="secondary"
        icon="plus"
        disabled={!sku.trim()}
        onClick={() => {
          onAdd({ sku: sku.trim(), nameSuffix: suffix || undefined, basePrice: price || undefined, barcode: barcode || undefined });
          setSku('');
          setSuffix('');
          setPrice('');
          setBarcode('');
        }}
      >
        Agregar variante
      </Button>
    </div>
  );
}

// ── Categorías ──────────────────────────────────────────────────────────────

function CategoriesPanel({
  categories,
  canManage,
  onChanged,
}: {
  categories: Category[];
  canManage: boolean;
  onChanged: () => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="grid-2">
      <Card title="Categorías" flush>
        <table className="table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th className="table__num">Productos</th>
              <th>Estado</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="table__num">{c.productCount}</td>
                <td>{c.isActive ? <Badge tone="positive">Activa</Badge> : <Badge>Inactiva</Badge>}</td>
                <td className="cell-actions">
                  {canManage && (
                    <>
                      <Button
                        size="sm"
                        variant="subtle"
                        icon="edit"
                        onClick={() => {
                          const next = window.prompt('Nuevo nombre de la categoría', c.name);
                          if (next && next.trim().length >= 2) void act(() => api.updateCategory(c.id, { name: next.trim() }));
                        }}
                      >
                        Renombrar
                      </Button>
                      <Button size="sm" variant="subtle" onClick={() => act(() => api.updateCategory(c.id, { isActive: !c.isActive }))}>
                        {c.isActive ? 'Desactivar' : 'Activar'}
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {canManage && (
        <Card title="Nueva categoría">
          <div className="stack">
            <Field label="Nombre" htmlFor="cat-name">
              <TextInput id="cat-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Fajas postparto" />
            </Field>
            <Button
              variant="primary"
              disabled={name.trim().length < 2}
              onClick={() =>
                act(async () => {
                  await api.createCategory({ name: name.trim() });
                  setName('');
                })
              }
            >
              Crear categoría
            </Button>
            {error && <Alert>{error}</Alert>}
          </div>
        </Card>
      )}
    </div>
  );
}
