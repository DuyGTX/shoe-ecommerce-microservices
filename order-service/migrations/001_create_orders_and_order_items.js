exports.up = (pgm) => {
  pgm.createTable("orders", {
    id: "id",
    user_id: { type: "integer", notNull: true },
    idempotency_key: { type: "varchar(255)" },
    total_amount: { type: "integer", notNull: true },
    status: { type: "varchar(50)", notNull: true, default: "Pending" },
    created_at: { type: "timestamp", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  }, { ifNotExists: true });

  pgm.createIndex("orders", ["user_id", "idempotency_key"], {
    name: "idx_orders_user_idempotency",
    unique: true,
    where: "idempotency_key IS NOT NULL",
    ifNotExists: true,
  });

  pgm.createTable("order_items", {
    id: "id",
    order_id: { type: "integer", references: "orders(id)", onDelete: "CASCADE" },
    product_id: { type: "varchar(255)", notNull: true },
    product_name: { type: "varchar(255)", notNull: true },
    price: { type: "integer", notNull: true },
    color: { type: "varchar(50)" },
    size: { type: "integer" },
    quantity: { type: "integer", notNull: true },
    total: { type: "integer", notNull: true },
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable("order_items", { ifExists: true });
  pgm.dropIndex("orders", ["user_id", "idempotency_key"], {
    name: "idx_orders_user_idempotency",
    ifExists: true,
  });
  pgm.dropTable("orders", { ifExists: true });
};