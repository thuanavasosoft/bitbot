// Modify this file to accomodate different running accounts
module.exports = {
  apps: [
    {
      name: 'dubai-main',
      script: 'dist/index.js',
      instances: 1,
      autorestart: false,
      watch: false,
      max_memory_restart: '1G',
      env_file: './env-files/dubai-main.env',
      error_file: './logs/dubai-main-err.log',
      out_file: './logs/dubai-main-out.log',
      log_file: './logs/dubai-main-combined.log',
      time: true
    }
  ]
  // Other accounts can be added below here
};
