exports.up = (pgm) => {
  pgm.createTable("users", {
    id: "id",
    email: { type: "varchar(255)", notNull: true, unique: true },
    password: { type: "varchar(255)", notNull: true },
    full_name: { type: "varchar(255)", notNull: true },
    created_at: { type: "timestamp", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  }, { ifNotExists: true });

  pgm.createTable("cart_items", {
    id: "id",
    user_id: { type: "integer", notNull: true },
    product_id: { type: "varchar(255)", notNull: true },
    product_name: { type: "varchar(255)", notNull: true },
    price: { type: "integer", notNull: true },
    color: { type: "varchar(50)", notNull: true },
    size: { type: "integer", notNull: true },
    quantity: { type: "integer", notNull: true },
    total: { type: "integer", notNull: true },
    created_at: { type: "timestamp", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  }, { ifNotExists: true });
};

exports.down = (pgm) => {
  pgm.dropTable("cart_items", { ifExists: true });
  pgm.dropTable("users", { ifExists: true });
};