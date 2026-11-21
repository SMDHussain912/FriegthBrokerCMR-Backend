# FreightBrokerCMR Backend — Database Backup & Recovery Guide

# Overview
This document outlines the database backup and recovery procedures for the FreightBrokerCMR backend, which uses MongoDB as its primary data store.

## 1. Backup Strategy

### 1.1 Backup Types
- **Full Backup**: Complete snapshot of all databases and collections
- **Incremental Backup**: Captures only changes since the last backup (via MongoDB Oplog)

### 1.2 Backup Schedule
| Frequency | Type | Retention |
|-----------|------|-----------|
| Daily | Full | 7 days |
| Weekly | Full | 4 weeks |
| Monthly | Full | 12 months |
| Continuous | Oplog | 24 hours |

### 1.3 Backup Locations
- Primary: `/var/backups/freightbroker/daily/`
- Secondary: `/var/backups/freightbroker/weekly/`
- Tertiary: `/var/backups/freightbroker/monthly/`
- Offsite: Cloud storage (S3/GCS/Azure Blob) as configured

## 2. Backup Procedures

### 2.1 Manual Backup (mongodump)
```bash
# Full database backup
mongodump \
  --uri="mongodb://localhost:27017" \
  --db=freightbroker \
  --out=/var/backups/freightbroker/daily/$(date +%Y%m%d)

# Compress backup
tar -czf freightbroker_$(date +%Y%m%d).tar.gz -C /var/backups/freightbroker/daily/ $(date +%Y%m%d)
```

### 2.2 Automated Backup (cron)
Add to crontab:
```bash
# Daily full backup at 2:00 AM
0 2 * * * /usr/local/bin/freightbroker-backup.sh >> /var/log/freightbroker/backup.log 2>&1

# Weekly full backup on Sundays at 1:00 AM
0 1 * * 0 /usr/local/bin/freightbroker-backup.sh --weekly >> /var/log/freightbroker/backup.log 2>&1

# Monthly full backup on 1st at 12:00 AM
0 0 1 * * /usr/local/bin/freightbroker-backup.sh --monthly >> /var/log/freightbroker/backup.log 2>&1
```

### 2.3 Backup Script Example
See `/home/arc/Documents/Web-Projects/FreightBrokerCMR/backend/scripts/backup.sh`

## 3. Restore Procedures

### 3.1 Restore from Backup (mongorestore)
```bash
# List available backups
ls -la /var/backups/freightbroker/daily/

# Restore from a specific backup
mongorestore \
  --uri="mongodb://localhost:27017" \
  --db=freightbroker \
  --drop \
  /var/backups/freightbroker/daily/20240115/

# Restore specific collection
mongorestore \
  --uri="mongodb://localhost:27017" \
  --db=freightbroker \
  --collection=loads \
  /var/backups/freightbroker/daily/20240115/freightbroker/loads.bson
```

### 3.2 Point-in-Time Recovery (Oplog)
For point-in-time recovery, use MongoDB Oplog:
```bash
# Restore base backup first
mongorestore --uri="mongodb://localhost:27017" --db=freightbroker --drop /var/backups/freightbroker/daily/20240115/

# Apply oplog changes up to a specific point in time
mongorestore --uri="mongodb://localhost:27017" --oplogReplay --oplogLimit="<timestamp>"
```

## 4. Health Checks

### 4.1 Application Health Endpoint
`GET /api/health` — Returns service status, database connection status, and uptime.

### 4.2 MongoDB Health Check
```bash
# Check MongoDB status
mongosh --eval "db.runCommand({ ping: 1 })"

# Check replication status (if replica set)
mongosh --eval "rs.status()"

# Check server statistics
mongosh --eval "db.serverStatus()"
```

### 4.3 Health Check Script
See `/home/arc/Documents/Web-Projects/FreightBrokerCMR/backend/scripts/health-check.sh`

## 5. Recovery Scenarios

### 5.1 Single Corrupt Document
1. Identify the corrupt document
2. Restore from nearest backup
3. Apply oplog changes up to just before corruption

### 5.2 Collection Corruption
1. Drop the corrupt collection
2. Restore collection from backup
3. Apply oplog changes

### 5.3 Database Corruption
1. Drop the database
2. Restore database from backup
3. Apply oplog changes up to recovery point

### 5.4 Complete Database Loss
1. Provision new MongoDB instance
2. Restore from latest full backup
3. Apply oplog changes up to recovery point
4. Verify data integrity

## 5. Verification Procedures

### 5.1 Backup Verification
```bash
# Verify backup integrity
mongorestore --uri="mongodb://localhost:27017" --db=test_verify --dryRun /var/backups/freightbroker/daily/20240115/
```

### 5.2 Restore Testing
- Perform monthly restore tests to a staging environment
- Verify data integrity after restore
- Document recovery time objectives (RTO) and recovery point objectives (RPO)

### 5.3 Backup Verification Script
See `/home/arc/Documents/Web-Projects/FreightBrokerCMR/backend/scripts/verify-backup.sh`

## 6. Recovery Objectives

| Metric | Target |
|--------|--------|
| Recovery Point Objective (RPO) | 24 hours (daily backups) |
| Recovery Time Objective (RTO) | 4 hours |
| Backup Retention | 30 days (daily), 12 months (monthly) |

## 7. Maintenance

### 7.1 Backup Rotation
Old backups are automatically purged based on retention policy:
- Daily backups: 30 days
- Weekly backups: 12 weeks
- Monthly backups: 12 months

### 7.2 Storage Monitoring
Monitor backup storage usage and alert when:
- Disk usage exceeds 80%
- Backup fails for 2 consecutive runs
- Backup size changes by more than 50%

## 8. Emergency Contacts
- Database Administrator: [Name/Contact]
- System Administrator: [Name/Contact]
- On-call Engineer: [Name/Contact]

## 9. Related Scripts
- `/home/arc/Documents/Web-Projects/FreightBrokerCMR/backend/scripts/backup.sh` — Backup script
- `/home/arc/Documents/Web-Projects/FreightBrokerCMR/backend/scripts/verify-backup.sh` — Backup verification
- `/home/arc/Documents/Web-Projects/FreightBrokerCMR/backend/scripts/health-check.sh` — Health check script
