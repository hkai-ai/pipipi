export const up = (pgm) => {
    pgm.sql(`
    CREATE TABLE service_instance_identity (
      singleton boolean PRIMARY KEY DEFAULT true,
      identity uuid NOT NULL,
      CONSTRAINT service_instance_identity_singleton_check
        CHECK (singleton)
    );

    INSERT INTO service_instance_identity (singleton, identity)
    VALUES (true, gen_random_uuid());

    REVOKE INSERT, UPDATE, DELETE, TRUNCATE
      ON service_instance_identity FROM PUBLIC;
  `);
};

export const down = (pgm) => {
    pgm.sql("DROP TABLE IF EXISTS service_instance_identity;");
};
