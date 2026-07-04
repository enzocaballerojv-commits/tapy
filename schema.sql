-- Esquema de base de datos para el negocio de fichas NFC
-- Se ejecuta una sola vez al crear la base de datos D1

CREATE TABLE clients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  business_type TEXT,
  contact_name TEXT,
  whatsapp TEXT,
  signup_date TEXT NOT NULL,
  plan TEXT NOT NULL,
  billing_freq TEXT NOT NULL DEFAULT 'mensual',
  price_one_time REAL,
  price_recurring REAL,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'activo',
  next_report_date TEXT,
  last_report_sent TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE chips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  slug TEXT NOT NULL UNIQUE,
  label TEXT,
  destination_url TEXT NOT NULL,
  suspended_url TEXT,
  password_note TEXT,
  last_reprogrammed TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE taps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chip_id INTEGER NOT NULL REFERENCES chips(id),
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Índices para que las consultas del dashboard y del redirect sean rápidas
CREATE INDEX idx_chips_slug ON chips(slug);
CREATE INDEX idx_chips_client ON chips(client_id);
CREATE INDEX idx_taps_chip ON taps(chip_id);
CREATE INDEX idx_taps_ts ON taps(ts);
CREATE INDEX idx_clients_status ON clients(status);
CREATE INDEX idx_clients_due ON clients(due_date);
