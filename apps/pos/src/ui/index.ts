/**
 * Superficie pública del sistema de diseño.
 *
 * Las pantallas importan SOLO desde aquí. Si algo hace falta en dos pantallas
 * y no está en esta lista, el sitio de arreglarlo es `src/ui`, no la pantalla.
 */
export { Icon, type IconName } from './Icon';
export {
  Alert,
  Badge,
  Button,
  Field,
  SearchInput,
  Segmented,
  Select,
  TextInput,
  type Tone,
} from './controls';
export { Card, EmptyState, Modal, PageHeader, SectionLabel, StatCard } from './layout';
