import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { ValidationError } from '../errors/domain-errors';

/**
 * Zonas horarias.
 *
 * Regla del proyecto:
 *
 *   ALMACENAR   siempre en UTC (TIMESTAMPTZ). Sin excepciones.
 *   PRESENTAR   siempre en la zona de la SUCURSAL del documento.
 *
 * No hay ninguna zona horaria escrita en el código. La empresa define la suya
 * y cada sucursal puede tener otra; una sucursal sin zona propia hereda la de
 * la empresa. Abrir una sucursal en otro estado —o del otro lado de la
 * frontera, donde sí hay horario de verano— no requiere tocar código.
 *
 * Por qué importa aquí más que en otros sistemas: el corte de caja, el "día
 * operativo" y los reportes diarios dependen de en qué día cae una venta. Si
 * el servidor está en UTC y la tienda en UTC−6, una venta de las 19:00 del
 * lunes en Chihuahua es martes 01:00 en UTC. Sin esta capa, el corte Z no
 * cuadra y nadie entiende por qué.
 */
@Injectable()
export class TimeZoneService {
  private readonly logger = new Logger(TimeZoneService.name);

  /** Caché de zonas resueltas por sucursal. Cambian casi nunca. */
  private readonly branchCache = new Map<string, string>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * ¿Es una zona IANA válida en este sistema?
   *
   * Se apoya en la base de datos IANA del runtime, no en una lista propia:
   * una lista escrita a mano envejece y rechaza zonas legítimas.
   */
  isValid(timeZone: string): boolean {
    if (!timeZone || typeof timeZone !== 'string') return false;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
      return true;
    } catch {
      return false;
    }
  }

  /** Valida o lanza un error de dominio con mensaje entendible. */
  assertValid(timeZone: string): string {
    if (!this.isValid(timeZone)) {
      throw new ValidationError(
        `"${timeZone}" no es una zona horaria válida. Usa un identificador IANA, por ejemplo "America/Chihuahua".`,
        { timeZone, examples: TimeZoneService.COMMON_MEXICO_ZONES },
      );
    }
    return timeZone;
  }

  /**
   * Zona EFECTIVA de una sucursal: la suya, o la de su empresa si no tiene.
   */
  async forBranch(branchId: string): Promise<string> {
    const cached = this.branchCache.get(branchId);
    if (cached) return cached;

    const branch = await this.prisma.client.branch.findUnique({
      where: { id: branchId },
      select: { timezone: true, company: { select: { timezone: true } } },
    });

    if (!branch) {
      throw new ValidationError(`No se encontró la sucursal ${branchId}`);
    }

    const resolved = branch.timezone ?? branch.company.timezone;
    this.branchCache.set(branchId, resolved);
    return resolved;
  }

  /** Invalida la caché tras cambiar la zona de una sucursal o empresa. */
  invalidate(branchId?: string): void {
    if (branchId) this.branchCache.delete(branchId);
    else this.branchCache.clear();
  }

  // ── Formato ────────────────────────────────────────────────────────────────

  /** Fecha y hora para ticket, pantalla o reporte: `05/09/2026 14:30`. */
  format(instant: Date, timeZone: string, options?: Intl.DateTimeFormatOptions): string {
    return new Intl.DateTimeFormat('es-MX', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      ...options,
    }).format(instant);
  }

  /** Solo la fecha: `05/09/2026`. */
  formatDate(instant: Date, timeZone: string): string {
    return this.format(instant, timeZone, {
      hour: undefined,
      minute: undefined,
    });
  }

  /**
   * Fecha civil (`YYYY-MM-DD`) del instante EN esa zona.
   * Es la clave para agrupar "ventas del día" sin que se cuelen las de
   * medianoche del día siguiente en UTC.
   */
  civilDate(instant: Date, timeZone: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);

    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((p) => p.type === type)?.value ?? '';

    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  /** Desfase respecto a UTC en minutos, en ese instante (respeta el horario de verano). */
  offsetMinutes(instant: Date, timeZone: string): number {
    const utc = new Date(
      Date.UTC(
        instant.getUTCFullYear(),
        instant.getUTCMonth(),
        instant.getUTCDate(),
        instant.getUTCHours(),
        instant.getUTCMinutes(),
        instant.getUTCSeconds(),
      ),
    );

    const local = new Date(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
        .format(instant)
        .replace(
          /(\d{2})\/(\d{2})\/(\d{4}), (\d{2}):(\d{2}):(\d{2})/,
          '$3-$1-$2T$4:$5:$6Z',
        ),
    );

    return Math.round((local.getTime() - utc.getTime()) / 60_000);
  }

  // ── Día operativo ──────────────────────────────────────────────────────────

  /**
   * Ventana UTC del día operativo de una sucursal.
   *
   * `businessDayCutoff` (HH:mm, en hora local de la sucursal) decide dónde
   * empieza el día. Con corte a las 00:00 es el día natural; con corte a las
   * 04:00, una venta de la 01:30 del martes todavía pertenece al lunes — que
   * es como lo cuenta quien cierra la caja de madrugada.
   *
   * Devuelve límites en UTC, listos para un `WHERE occurred_at >= … AND < …`.
   */
  businessDayRange(
    civilDate: string,
    timeZone: string,
    cutoff = '00:00',
  ): { from: Date; to: Date } {
    const [hourText, minuteText] = cutoff.split(':');
    const hour = Number(hourText ?? 0);
    const minute = Number(minuteText ?? 0);

    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new ValidationError(`Hora de corte inválida: "${cutoff}". Usa el formato HH:mm.`);
    }

    const from = this.zonedTimeToUtc(civilDate, hour, minute, timeZone);
    const to = new Date(from.getTime() + 24 * 3_600_000);

    return { from, to };
  }

  /**
   * Convierte una hora local de una zona al instante UTC correspondiente.
   *
   * Se resuelve por aproximación y corrección: se estima con el desfase del
   * momento y se ajusta. Dos iteraciones bastan incluso en los días en que
   * cambia el horario de verano, cuando el desfase de la mañana no es el
   * mismo que el de la tarde.
   */
  zonedTimeToUtc(
    civilDate: string,
    hour: number,
    minute: number,
    timeZone: string,
  ): Date {
    const [year, month, day] = civilDate.split('-').map(Number);

    if (!year || !month || !day) {
      throw new ValidationError(`Fecha inválida: "${civilDate}". Usa el formato YYYY-MM-DD.`);
    }

    let instant = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

    for (let i = 0; i < 2; i++) {
      const offset = this.offsetMinutes(instant, timeZone);
      const corrected = new Date(
        Date.UTC(year, month - 1, day, hour, minute, 0, 0) - offset * 60_000,
      );
      if (corrected.getTime() === instant.getTime()) break;
      instant = corrected;
    }

    return instant;
  }

  /** Día operativo actual de una sucursal, en su propia zona. */
  async currentBusinessDay(branchId: string): Promise<{
    civilDate: string;
    timeZone: string;
    from: Date;
    to: Date;
  }> {
    const branch = await this.prisma.client.branch.findUnique({
      where: { id: branchId },
      select: {
        timezone: true,
        businessDayCutoff: true,
        company: { select: { timezone: true } },
      },
    });

    if (!branch) throw new ValidationError(`No se encontró la sucursal ${branchId}`);

    const timeZone = branch.timezone ?? branch.company.timezone;
    const now = new Date();

    // Con corte distinto de medianoche, antes del corte todavía es "ayer".
    const [cutoffHourText] = branch.businessDayCutoff.split(':');
    const cutoffHour = Number(cutoffHourText ?? 0);

    let civilDate = this.civilDate(now, timeZone);

    if (cutoffHour > 0) {
      const localHour = Number(
        new Intl.DateTimeFormat('en-US', {
          timeZone,
          hour: '2-digit',
          hour12: false,
        }).format(now),
      );
      if (localHour < cutoffHour) {
        const yesterday = new Date(now.getTime() - 24 * 3_600_000);
        civilDate = this.civilDate(yesterday, timeZone);
      }
    }

    const range = this.businessDayRange(civilDate, timeZone, branch.businessDayCutoff);
    return { civilDate, timeZone, ...range };
  }

  /**
   * Zonas de México, para el selector de la interfaz.
   *
   * Desde 2022 México eliminó el horario de verano, SALVO en los municipios de
   * la franja fronteriza, que siguen las reglas de Estados Unidos. Por eso
   * Ciudad Juárez tiene zona propia y distinta a la del resto de Chihuahua:
   * confundirlas desfasa una hora los cortes de caja media parte del año.
   */
  static readonly COMMON_MEXICO_ZONES = [
    { id: 'America/Mexico_City', label: 'Centro (Ciudad de México)', dst: false },
    { id: 'America/Chihuahua', label: 'Chihuahua (excepto frontera)', dst: false },
    { id: 'America/Ciudad_Juarez', label: 'Ciudad Juárez y franja fronteriza', dst: true },
    { id: 'America/Monterrey', label: 'Monterrey', dst: false },
    { id: 'America/Hermosillo', label: 'Sonora', dst: false },
    { id: 'America/Tijuana', label: 'Baja California', dst: true },
    { id: 'America/Mazatlan', label: 'Sinaloa, Nayarit', dst: false },
    { id: 'America/Cancun', label: 'Quintana Roo', dst: false },
    { id: 'America/Merida', label: 'Yucatán', dst: false },
  ] as const;

  /** Zonas soportadas por el runtime, para un selector completo. */
  listAvailable(): string[] {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf;

    if (typeof supported === 'function') {
      return supported('timeZone');
    }

    this.logger.warn(
      'Intl.supportedValuesOf no está disponible; se ofrece solo la lista de México.',
    );
    return TimeZoneService.COMMON_MEXICO_ZONES.map((z) => z.id);
  }
}
