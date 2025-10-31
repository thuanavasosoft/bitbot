// Modify this file to accomodate different running accounts
module.exports = {
  apps: [
    {
      name: 'dubai-main',
      script: 'node dist/index.js',
      instances: 1,
      autorestart: false,
      watch: false,
      max_memory_restart: '3G',
      env_file: './env-files/dubai-main.env',
      error_file: './logs/dubai-main-err.log',
      out_file: './logs/dubai-main-out.log',
      log_file: './logs/dubai-main-combined.log',
      time: true
    },
    {
      name: 'vesse',
      script: 'node dist/index.js',
      instances: 1,
      autorestart: false,
      watch: false,
      max_memory_restart: '3G',
      env_file: './env-files/vesse.env',
      error_file: './logs/vesse-err.log',
      out_file: './logs/vesse-out.log',
      log_file: './logs/vesse-combined.log',
      time: true
    },
    {
      name: 'vivek',
      script: 'node dist/index.js',
      instances: 1,
      autorestart: false,
      watch: false,
      max_memory_restart: '3G',
      env_file: './env-files/vivek.env',
      error_file: './logs/vivek-err.log',
      out_file: './logs/vivek-out.log',
      log_file: './logs/vivek-combined.log',
      time: true
    },
    {
      name: 'dubai-sub-1',
      script: 'node dist/index.js',
      instances: 1,
      autorestart: false,
      watch: false,
      max_memory_restart: '3G',
      env_file: './env-files/dubai-sub-1.env',
      error_file: './logs/dubai-sub-1-err.log',
      out_file: './logs/dubai-sub-1-out.log',
      log_file: './logs/dubai-sub-1-combined.log',
      time: true
    }
  ]
  // Other accounts can be added below here
};
