/**
 * Las pruebas unitarias no tocan la base ni leen el .env del desarrollador:
 * se les da una configuración fija para que su resultado no dependa de la
 * máquina donde corren.
 */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5433/test?schema=public';
process.env.JWT_ACCESS_SECRET ??= 'test_secret_de_acceso_solo_para_pruebas_32chars';
process.env.JWT_REFRESH_SECRET ??= 'test_secret_de_refresco_solo_para_pruebas_32chars';
process.env.ENCRYPTION_KEY ??= 'cHJ1ZWJhcy1jbGF2ZS1kZS1jaWZyYWRvLTMyYnl0ZXM=';
process.env.LOG_LEVEL ??= 'silent';
