-- Ejecutar DESPUÉS de schema.sql
-- Tabla de configuración general (inventario de chips, alias bancario, etc.)

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- Valores iniciales, editables después desde el panel
INSERT INTO settings (key, value) VALUES ('total_chips_purchased', '100');
INSERT INTO settings (key, value) VALUES ('cost_per_chip_usd', '0.10');
INSERT INTO settings (key, value) VALUES ('alias_bancario', 'PENDIENTE_DE_CONFIGURAR');
