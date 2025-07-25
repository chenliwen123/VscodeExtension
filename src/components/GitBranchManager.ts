import * as vscode from 'vscode';
import * as path from 'path';
import { execAsync } from '../utils/execAsync';

/**
 * Git分支管理器
 * 基于你的autoMerge.js功能，提供VSCode集成的Git分支自动合并功能
 */
export class GitBranchManager {
    private outputChannel: vscode.OutputChannel;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Git Branch Manager');
    }

    /**
     * 自动合并分支到dev和sit
     */
    async autoMergeBranch(e: any = { rootUri: { fsPath: '' } }): Promise<void> {
        try {
            this.outputChannel.show();
            this.log('🚀 开始自动合并分支...');

            // 从事件参数中获取仓库路径
            let currentRepo: string | undefined;

            if (e && e.rootUri) {
                // 从Git扩展的事件中获取仓库路径
                currentRepo = e.rootUri.fsPath;
                this.log(`📁 选中仓库: ${path.basename(currentRepo || '')}`);
            } else if (e && e.resourceUri) {
                // 从资源URI中获取仓库路径
                currentRepo = e.resourceUri.fsPath;
                this.log(`📁 资源仓库: ${path.basename(currentRepo || '')}`);
            } else {
                // 回退到自动检测
                currentRepo = await this.getCurrentGitRepository();
                if (!currentRepo) {
                    const message = '未找到Git仓库，请在Git项目中使用此功能';
                    this.log(`❌ ${message}`);
                    vscode.window.showErrorMessage(message);
                    return;
                }
                this.log(`📁 自动检测仓库: ${path.basename(currentRepo || '')}`);
            }

            // 确保currentRepo不为undefined
            if (!currentRepo) {
                const message = '无法确定Git仓库路径';
                this.log(`❌ ${message}`);
                vscode.window.showErrorMessage(message);
                return;
            }

            // 检查是否在Git仓库中
            if (!(await this.isGitRepository(currentRepo))) {
                const message = '当前目录不是Git仓库，请在Git项目中使用此功能';
                this.log(`❌ ${message}`);
                vscode.window.showErrorMessage(message);
                return;
            }

            // 检查工作区是否干净
            if (!(await this.isWorkingDirectoryClean(currentRepo))) {
                const message = '工作区有未提交的更改，请先提交或暂存更改后再进行合并操作';
                this.log(`⚠️ ${message}`);
                const action = await vscode.window.showWarningMessage(
                    message,
                    '查看更改',
                    '继续操作',
                    '取消'
                );

                if (action === '查看更改') {
                    vscode.commands.executeCommand('git.openChange');
                    return;
                } else if (action !== '继续操作') {
                    this.log('❌ 用户取消操作');
                    return;
                }
            }

            // 获取当前分支
            const currentBranch = await this.getCurrentBranch(currentRepo);
            this.log(`📍 当前分支: ${currentBranch}`);

            // 检查当前分支是否为dev或sit
            if (currentBranch === 'dev' || currentBranch === 'sit') {
                const message = `当前分支是 ${currentBranch}，不能将其合并到自身。请切换到功能分支后再执行合并操作。`;
                this.log(`⚠️ ${message}`);
                vscode.window.showWarningMessage(message);
                return;
            }

            // 直接执行合并流程
            await this.executeMergeFlow(currentBranch, currentBranch, currentRepo);

        } catch (error) {
            this.logError('合并过程中发生错误', error);

            // 提供更友好的错误信息
            let errorMessage = '合并失败';
            if (error instanceof Error) {
                if (error.message.includes('not a git repository')) {
                    errorMessage = '当前目录不是Git仓库，请在Git项目中使用此功能';
                } else if (error.message.includes('fatal: not a git repository')) {
                    errorMessage = '请确保在Git仓库的根目录下使用此功能';
                } else {
                    errorMessage = `合并失败: ${error.message}`;
                }
            }

            vscode.window.showErrorMessage(errorMessage);
        }
    }

    /**
     * 获取当前选中的Git仓库路径
     * 通过Git扩展API获取用户当前操作的仓库
     */
    private async getCurrentGitRepository(): Promise<string | undefined> {
        try {
            // 获取Git扩展
            const gitExtension = vscode.extensions.getExtension('vscode.git');
            if (!gitExtension) {
                return this.getFallbackRepository();
            }

            const git = gitExtension.exports.getAPI(1);
            if (!git || git.repositories.length === 0) {
                return this.getFallbackRepository();
            }

            // 如果只有一个仓库，直接返回
            if (git.repositories.length === 1) {
                return git.repositories[0].rootUri.fsPath;
            }

            // 多仓库情况：尝试通过SCM视图获取当前选中的仓库
            const selectedRepository = await this.getSelectedRepository(git);
            if (selectedRepository) {
                return selectedRepository;
            }

            // 如果无法确定选中的仓库，让用户选择
            return await this.promptUserToSelectRepository(git);

        } catch (error) {
            this.logError('获取Git仓库失败', error);
            return this.getFallbackRepository();
        }
    }

    /**
     * 获取用户选中的仓库（通过SCM视图状态）
     */
    private async getSelectedRepository(git: any): Promise<string | undefined> {
        // 尝试通过当前活动的SCM资源组获取仓库
        try {
            // 检查是否有活动的文件属于某个仓库
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                const activeFilePath = activeEditor.document.uri.fsPath;
                for (const repo of git.repositories) {
                    const repoPath = repo.rootUri.fsPath;
                    if (activeFilePath.startsWith(repoPath)) {
                        return repoPath;
                    }
                }
            }
        } catch (error) {
            // 忽略错误，继续其他方法
        }
        return undefined;
    }

    /**
     * 让用户选择要操作的仓库
     */
    private async promptUserToSelectRepository(git: any): Promise<string | undefined> {
        interface RepoQuickPickItem extends vscode.QuickPickItem {
            repoPath: string;
        }

        const repoItems: RepoQuickPickItem[] = git.repositories.map((repo: any) => ({
            label: path.basename(repo.rootUri.fsPath),
            description: repo.rootUri.fsPath,
            repoPath: repo.rootUri.fsPath
        }));

        const selected = await vscode.window.showQuickPick(repoItems, {
            placeHolder: '选择要进行自动合并的Git仓库',
            title: '多仓库检测'
        });

        return selected ? selected.repoPath : undefined;
    }

    /**
     * 获取回退仓库（工作区第一个文件夹）
     */
    private getFallbackRepository(): string | undefined {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return workspaceFolders[0].uri.fsPath;
        }
        return undefined;
    }

    /**
     * 执行Git命令
     */
    private async execGitCommand(command: string, workingDirectory?: string): Promise<{ stdout: string; stderr: string }> {
        const cwd = workingDirectory || await this.getCurrentGitRepository();
        const options = cwd ? { cwd } : {};
        return await execAsync(command, options);
    }

    /**
     * 检查是否在Git仓库中
     */
    private async isGitRepository(workingDirectory?: string): Promise<boolean> {
        try {
            await this.execGitCommand('git rev-parse --git-dir', workingDirectory);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 检查工作区是否干净（没有未提交的更改）
     */
    private async isWorkingDirectoryClean(workingDirectory?: string): Promise<boolean> {
        try {
            const { stdout } = await this.execGitCommand('git status --porcelain', workingDirectory);
            return stdout.trim().length === 0;
        } catch {
            return false;
        }
    }

    /**
     * 获取当前分支
     */
    private async getCurrentBranch(workingDirectory?: string): Promise<string> {
        const { stdout } = await this.execGitCommand('git rev-parse --abbrev-ref HEAD', workingDirectory);
        return stdout.trim();
    }







    /**
     * 执行合并流程
     */
    private async executeMergeFlow(branchToMerge: string, originalBranch: string, workingDirectory: string): Promise<void> {
        let isCancelled = false;

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: '自动合并分支 (点击取消可中止)',
                cancellable: true
            }, async (progress, token) => {

                // 监听取消事件
                token.onCancellationRequested(() => {
                    isCancelled = true;
                    this.log('⚠️ 用户取消了合并操作');
                });

                // 步骤1: 确保当前分支代码是最新的
                if (token.isCancellationRequested) return;
                progress.report({ increment: 15, message: `拉取 ${branchToMerge} 分支最新代码...` });
                await this.pullCurrentBranch(branchToMerge, workingDirectory);

                // 步骤2: 合并到dev分支
                if (token.isCancellationRequested) return;
                progress.report({ increment: 35, message: '合并到 dev 分支...' });
                await this.mergeToTargetBranch(branchToMerge, 'dev', workingDirectory);

                // 步骤3: 合并到sit分支
                if (token.isCancellationRequested) return;
                progress.report({ increment: 35, message: '合并到 sit 分支...' });
                await this.mergeToTargetBranch('dev', 'sit', workingDirectory);

                // 步骤4: 切换回原分支
                if (token.isCancellationRequested) return;
                progress.report({ increment: 15, message: `切换回 ${originalBranch} 分支...` });
                await this.switchToBranch(originalBranch, workingDirectory);

                if (!token.isCancellationRequested) {
                    progress.report({ message: '合并完成!' });
                }
            });

            if (isCancelled) {
                this.log('❌ 合并操作已取消');
                vscode.window.showWarningMessage('⚠️ 合并操作已取消');
            } else {
                this.log('✅ 自动合并完成!');
                vscode.window.showInformationMessage('🎉 分支自动合并成功!');
            }
        } catch (error) {
            if (isCancelled) {
                this.log('❌ 合并操作已取消');
                vscode.window.showWarningMessage('⚠️ 合并操作已取消');
            } else {
                throw error; // 重新抛出非取消相关的错误
            }
        }
    }

    /**
     * 拉取当前分支最新代码
     */
    private async pullCurrentBranch(branch: string, workingDirectory?: string): Promise<void> { //
        this.log(`⬇️ 拉取 ${branch} 分支最新代码...`);
        await this.execGitCommand(`git pull origin ${branch}`, workingDirectory);
    }

    /**
     * 切换到指定分支
     */
    private async switchToBranch(branch: string, workingDirectory?: string): Promise<void> {
        this.log(`🔄 切换到 ${branch} 分支...`);
        await this.execGitCommand(`git checkout ${branch}`, workingDirectory);
    }

    /**
     * 合并到目标分支
     */
    private async mergeToTargetBranch(sourceBranch: string, targetBranch: string, workingDirectory?: string): Promise<void> {
        // 切换到目标分支
        await this.switchToBranch(targetBranch, workingDirectory);

        // 拉取目标分支最新代码
        this.log(`⬇️ 拉取 ${targetBranch} 分支最新代码...`);
        await this.execGitCommand(`git pull origin ${targetBranch}`, workingDirectory);

        // 合并源分支
        this.log(`🔀 合并 ${sourceBranch} 到 ${targetBranch}...`);
        await this.execGitCommand(`git merge ${sourceBranch}`, workingDirectory);

        // 检查是否有冲突
        if (await this.checkMergeConflict(workingDirectory)) {
            throw new Error(`合并 ${sourceBranch} 到 ${targetBranch} 时发生冲突，请手动解决`);
        }

        // 推送到远程
        this.log(`⬆️ 推送 ${targetBranch} 分支...`);
        await this.execGitCommand(`git push origin ${targetBranch}:${targetBranch}`, workingDirectory);
    }

    /**
     * 检查是否有合并冲突
     */
    private async checkMergeConflict(workingDirectory?: string): Promise<boolean> {
        try {
            const { stdout } = await this.execGitCommand('git status --porcelain', workingDirectory);
            return stdout.includes('UU') || stdout.includes('AA') || stdout.includes('DD');
        } catch {
            return false;
        }
    }

    /**
     * 记录日志
     */
    private log(message: string): void {
        const timestamp = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${timestamp}] ${message}`);
    }

    /**
     * 记录错误日志
     */
    private logError(message: string, error: any): void {
        const timestamp = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${timestamp}] ❌ ${message}: ${error}`);
    }

    /**
     * 注册VSCode命令
     */
    registerCommands(): vscode.Disposable[] {
        const autoMergeCommand = vscode.commands.registerCommand(
            'extension.autoMergeBranch',
            (e) => this.autoMergeBranch(e)
        );

        return [autoMergeCommand];
    }



    /**
     * 释放资源
     */
    dispose(): void {
        this.outputChannel.dispose();
    }
}
