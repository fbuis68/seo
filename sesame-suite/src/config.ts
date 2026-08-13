import "dotenv/config";

export const config = {
  port: parseInt(process.env.PORT || "3000", 10),
  jwtSecret: process.env.JWT_SECRET || "change-me-in-production",
  defaultEntityCode: process.env.DEFAULT_ENTITY_CODE || "E00000001",
};
