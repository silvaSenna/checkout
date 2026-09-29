CREATE TABLE payments (
  id uuid PRIMARY KEY,
  cpf varchar(11) NOT NULL CHECK (cpf ~ '^[0-9]{11}$'),
  description varchar(255) NOT NULL CHECK (length(trim(description)) > 0),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 1 AND 99999999),
  payment_method varchar(20) NOT NULL CHECK (payment_method IN ('PIX', 'CREDIT_CARD')),
  status varchar(10) NOT NULL CHECK (status IN ('PENDING', 'PAID', 'FAIL')),
  checkout_status varchar(20) NOT NULL CHECK (checkout_status IN ('NOT_REQUIRED', 'PROCESSING', 'READY', 'REQUIRES_REVIEW')),
  preference_id text UNIQUE,
  checkout_url text,
  provider_payment_id text UNIQUE,
  provider_updated_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((preference_id IS NULL) = (checkout_url IS NULL))
);
CREATE INDEX payments_cpf_id_idx ON payments(cpf, id);
CREATE INDEX payments_method_id_idx ON payments(payment_method, id);
CREATE INDEX payments_status_id_idx ON payments(status, id);

CREATE TABLE idempotency_keys (
  key varchar(128) PRIMARY KEY,
  fingerprint char(64) NOT NULL,
  payment_id uuid NOT NULL REFERENCES payments(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  kind varchar(30) NOT NULL CHECK (kind IN ('CREATE_PREFERENCE', 'SYNC_PAYMENT')),
  dedup_key text NOT NULL UNIQUE,
  payload jsonb NOT NULL,
  status varchar(15) NOT NULL DEFAULT 'READY' CHECK (status IN ('READY', 'RUNNING', 'DONE', 'DEAD')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  lease_token uuid,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_available_idx ON jobs(available_at, created_at) WHERE status IN ('READY', 'RUNNING');

CREATE TABLE payment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES payments(id),
  previous_status varchar(10),
  status varchar(10) NOT NULL,
  version integer NOT NULL,
  actor varchar(30) NOT NULL,
  provider_payment_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(payment_id, version)
);
