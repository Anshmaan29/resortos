# First property and owner

Use a new PostgreSQL database after migrations. This operator command refuses any database already containing a property, and concurrent attempts cannot create two initial properties. It writes a live property and owner with Argon2id password/PIN hashes, an audit entry and an outbox event. It inserts no demo guests, room prices or GST rates.

Set `MIGRATION_DATABASE_URL`, `PROVISION_OWNER_PASSWORD` and `PROVISION_OWNER_PIN` securely in the local environment. Do not put passwords/PINs in the JSON file, command arguments or Git. The password must meet the same rules as normal accounts and the owner PIN must contain six nontrivial digits.

Prepare a local JSON file with this shape, using the property's actual details:

```json
{
  "property": {
    "name": "Your property name", "legalName": "Registered legal name",
    "addressLine1": "Your street address", "city": "Your city",
    "stateCode": "08", "pinCode": "302001", "phone": "9876543210",
    "email": "owner@yourdomain.com", "checkInTime": "12:00", "checkOutTime": "11:00"
  },
  "businessDate": "2026-10-06",
  "owner": { "fullName": "Owner name", "username": "your.owner", "email": "owner@yourdomain.com" }
}
```

All sample identity values above must be replaced. Add `gstin` only for a registered property; it must pass checksum validation and match the state. The business date must be the intended opening day; it cannot move backwards later.

From the repository:

```sh
pnpm db:migrate
pnpm --filter @resortos/api provision /absolute/path/property.json
```

Sign in, print and safely store recovery codes in Security settings, create room types and rooms, configure base/minimum/extra-person and dated room rates, meal plans, payment accounts, staff and CA-confirmed tax rules. Save the Resend sender and recipients in Guest messages. Use only a practice/staging environment for acceptance tests. Complete Gate 0 in `docs/production-readiness.md` before entering real guest data.
