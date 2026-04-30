export const colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bright: '\x1b[1m',
};

function stamp(): string {
  return new Date().toISOString();
}

function line(label: string, color: string, message: string): void {
  console.log(`${color}${label}${colors.reset} ${colors.dim}${stamp()}${colors.reset} ${message}`);
}

export const log = {
  info(message: string): void {
    line('[INFO]', colors.cyan, message);
  },
  warn(message: string): void {
    line('[WARN]', colors.yellow, message);
  },
  error(message: string, error?: unknown): void {
    const suffix = error instanceof Error ? `\n${error.stack ?? error.message}` : error ? `\n${String(error)}` : '';
    line('[ERR ]', colors.red, `${message}${suffix}`);
  },
  pi(message: string): void {
    line('[PI  ]', colors.magenta, message);
  },
  feishu(message: string): void {
    line('[LARK]', colors.green, message);
  },
  queue(message: string): void {
    line('[Q   ]', colors.blue, message);
  },
  memory(message: string): void {
    line('[MEM ]', colors.white, message);
  },
};
