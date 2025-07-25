import { exec } from 'child_process';
import { promisify } from 'util';

/**
 * 异步执行命令的工具函数
 */
export const execAsync = promisify(exec);
