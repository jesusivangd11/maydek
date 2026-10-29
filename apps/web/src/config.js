/**
 * CONFIGURACIÓN DEL SITIO — el único archivo que hay que editar.
 *
 * Nombre comercial, precios, datos de contacto y datos legales viven aquí y en
 * ningún otro lado: las páginas los toman de este objeto. Un dato vacío ('')
 * se oculta en la página en vez de mostrarse inventado.
 */
export const SITE = {
  brand: 'Maydek',
  product: 'Punto de Venta',
  tagline: 'Punto de venta, inventario y administración para tu negocio. Se instala en tu computadora y funciona sin internet.',

  /** Dejar vacío lo que no se use: no se muestra. */
  contact: {
    email: 'jesus.ivan.gd11@gmail.com',
    phone: '614 133 6763',
    /** Solo dígitos con lada de país (52) para el enlace de WhatsApp. */
    whatsapp: '526141336763',
    hours: 'Lunes a sábado de 9:00 a 19:00 (hora del centro de México)',
    city: 'Chihuahua, Chihuahua, México',
  },

  /**
   * Titular del sitio y de la licencia, para el aviso de privacidad y los
   * términos. La ley pide el nombre completo y un domicilio para recibir
   * notificaciones: mientras estén vacíos, las páginas legales lo señalan.
   */
  legal: {
    ownerName: 'Jesús Iván García Delgado',
    address: 'Ignacio Rodríguez #113, colonia Diego Lucero, C.P. 31123, Chihuahua, Chih.',
    rfc: '',
    jurisdiction: 'Chihuahua, Chihuahua',
    updated: '28 de octubre de 2026',
  },

  /** Instalador para Windows. Vacío = el botón pide el instalador por ticket. */
  download: {
    url: '',
    version: '1.0.0',
    size: '',
  },

  /** Precios en MXN con IVA incluido. El anual se cobra como 10 meses. */
  plans: [
    {
      id: 'BASICO',
      name: 'Básico',
      monthly: 349,
      audience: 'Para la tienda que empieza a ordenar su caja.',
      limits: ['1 caja', '2 usuarios', 'Hasta 2,000 productos'],
      features: [
        'Venta con lector de código de barras',
        'Caja con corte X y Z',
        'Inventario con kardex',
        'Devoluciones y cancelaciones',
        'Ticket térmico de 58 y 80 mm',
        'Soporte por ticket y correo',
      ],
      highlighted: false,
    },
    {
      id: 'PROFESIONAL',
      name: 'Profesional',
      monthly: 699,
      audience: 'Para el negocio que vende a crédito y compra a varios proveedores.',
      limits: ['3 cajas en red', '10 usuarios', 'Productos ilimitados'],
      features: [
        'Todo lo del plan Básico',
        'Clientes, crédito y estado de cuenta',
        'Listas de precios de mayoreo',
        'Compras, proveedores y costo puesto en bodega',
        'Notas de crédito y pago mixto',
        'Reportes de utilidad y exportación a Excel',
        'Soporte prioritario por WhatsApp',
      ],
      highlighted: true,
    },
    {
      id: 'EMPRESARIAL',
      name: 'Empresarial',
      monthly: 1299,
      audience: 'Para el negocio grande con muchas cajas y almacenes.',
      limits: ['Cajas ilimitadas', 'Usuarios ilimitados', 'Varios almacenes'],
      features: [
        'Todo lo del plan Profesional',
        'Roles y permisos a la medida',
        'Auditoría completa de operaciones',
        'API para conectar tu tienda en línea (próximamente)',
        'Instalación y configuración a distancia',
        'Capacitación en línea para tu equipo',
        'Asesor asignado',
      ],
      highlighted: false,
    },
  ],

  /** Meses que se cobran al pagar un año por adelantado. */
  annualMonthsCharged: 10,
};
