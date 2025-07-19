import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';

const execAsync = promisify(exec);

/**
 * Git分支管理器
 * 基于你的autoMerge.js功能，提供VSCode集成的Git分支自动合并功能
 */
export class GitBranchManager {
    private outputChannel: vscode.OutputChannel;
    private workingDirectory: string | undefined;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Git Branch Manager');
        this.workingDirectory = this.getWorkspaceRoot();
    }

    /**
     * 自动合并分支到dev和sit
     */
    async autoMergeBranch(): Promise<void> {
        try {
            this.outputChannel.show();
            this.log('🚀 开始自动合并分支...');

            // 检查是否在Git仓库中
            if (!(await this.isGitRepository())) {
                const message = '当前工作区不是Git仓库，请在Git项目中使用此功能';
                this.log(`❌ ${message}`);
                vscode.window.showErrorMessage(message);
                return;
            }

            // 检查工作区是否干净
            if (!(await this.isWorkingDirectoryClean())) {
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
            const currentBranch = await this.getCurrentBranch();
            this.log(`📍 当前分支: ${currentBranch}`);

            // 让用户选择要合并的分支
            const branchToMerge = await this.selectBranchToMerge(currentBranch);
            if (!branchToMerge) {
                this.log('❌ 用户取消操作');
                return;
            }

            // 确认合并操作
            const confirmed = await this.confirmMergeOperation(branchToMerge);
            if (!confirmed) {
                this.log('❌ 用户取消合并操作');
                return;
            }

            // 执行合并流程
            await this.executeMergeFlow(branchToMerge, currentBranch);

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
     * 获取工作区根目录
     */
    private getWorkspaceRoot(): string | undefined {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return workspaceFolders[0].uri.fsPath;
        }
        return undefined;
    }

    /**
     * 执行Git命令
     */
    private async execGitCommand(command: string): Promise<{ stdout: string; stderr: string }> {
        const options = this.workingDirectory ? { cwd: this.workingDirectory } : {};
        return await execAsync(command, options);
    }

    /**
     * 检查是否在Git仓库中
     */
    private async isGitRepository(): Promise<boolean> {
        try {
            await this.execGitCommand('git rev-parse --git-dir');
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 检查工作区是否干净（没有未提交的更改）
     */
    private async isWorkingDirectoryClean(): Promise<boolean> {
        try {
            const { stdout } = await this.execGitCommand('git status --porcelain');
            return stdout.trim().length === 0;
        } catch {
            return false;
        }
    }

    /**
     * 获取当前分支
     */
    private async getCurrentBranch(): Promise<string> {
        const { stdout } = await this.execGitCommand('git rev-parse --abbrev-ref HEAD');
        return stdout.trim();
    }

    /**
     * 让用户选择要合并的分支
     */
    private async selectBranchToMerge(currentBranch: string): Promise<string | undefined> {
        const branches = await this.getAllBranches();
        
        const items = branches.map(branch => ({
            label: branch,
            description: branch === currentBranch ? '(当前分支)' : '',
            picked: branch === currentBranch
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: '选择要合并的分支',
            title: '自动合并分支'
        });

        return selected?.label;
    }

    /**
     * 获取所有分支
     */
    private async getAllBranches(): Promise<string[]> {
        try {
            const { stdout } = await this.execGitCommand('git branch -a');
            return stdout
                .split('\n')
                .map(branch => branch.replace(/^\*?\s+/, '').replace(/^remotes\/origin\//, ''))
                .filter(branch => branch && !branch.includes('HEAD'))
                .filter((branch, index, arr) => arr.indexOf(branch) === index); // 去重
        } catch (error) {
            this.logError('获取分支列表失败', error);
            return [];
        }
    }

    /**
     * 确认合并操作
     */
    private async confirmMergeOperation(branchToMerge: string): Promise<boolean> {
        const message = `确认要将分支 "${branchToMerge}" 自动合并到 dev 和 sit 分支吗？\n\n操作流程：\n1. 切换到 ${branchToMerge} 分支并拉取最新代码\n2. 合并到 dev 分支并推送\n3. 合并到 sit 分支并推送\n4. 切换回原分支`;
        
        const result = await vscode.window.showWarningMessage(
            message,
            { modal: true },
            '确认合并',
            '取消'
        );

        return result === '确认合并';
    }

    /**
     * 执行合并流程
     */
    private async executeMergeFlow(branchToMerge: string, originalBranch: string): Promise<void> {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '自动合并分支',
            cancellable: false
        }, async (progress) => {

            // 步骤1: 切换到目标分支并拉取
            progress.report({ increment: 10, message: `切换到 ${branchToMerge} 分支...` });
            await this.switchAndPullBranch(branchToMerge);

            // 步骤2: 合并到dev分支
            progress.report({ increment: 30, message: '合并到 dev 分支...' });
            await this.mergeToTargetBranch(branchToMerge, 'dev');

            // 步骤3: 合并到sit分支
            progress.report({ increment: 30, message: '合并到 sit 分支...' });
            await this.mergeToTargetBranch('dev', 'sit');

            // 步骤4: 切换回原分支
            progress.report({ increment: 20, message: `切换回 ${originalBranch} 分支...` });
            await this.switchToBranch(originalBranch);

            progress.report({ increment: 10, message: '合并完成!' });
        });

        this.log('✅ 自动合并完成!');
        vscode.window.showInformationMessage('🎉 分支自动合并成功!');
    }

    /**
     * 切换分支并拉取最新代码
     */
    private async switchAndPullBranch(branch: string): Promise<void> {
        this.log(`🔄 切换到 ${branch} 分支...`);
        await this.execGitCommand(`git checkout ${branch}`);

        this.log(`⬇️ 拉取 ${branch} 分支最新代码...`);
        await this.execGitCommand(`git pull origin ${branch}`);
    }

    /**
     * 切换到指定分支
     */
    private async switchToBranch(branch: string): Promise<void> {
        this.log(`🔄 切换到 ${branch} 分支...`);
        await this.execGitCommand(`git checkout ${branch}`);
    }

    /**
     * 合并到目标分支
     */
    private async mergeToTargetBranch(sourceBranch: string, targetBranch: string): Promise<void> {
        // 切换到目标分支
        await this.switchToBranch(targetBranch);

        // 拉取目标分支最新代码
        this.log(`⬇️ 拉取 ${targetBranch} 分支最新代码...`);
        await this.execGitCommand(`git pull origin ${targetBranch}`);

        // 合并源分支
        this.log(`🔀 合并 ${sourceBranch} 到 ${targetBranch}...`);
        await this.execGitCommand(`git merge ${sourceBranch}`);

        // 检查是否有冲突
        if (await this.checkMergeConflict()) {
            throw new Error(`合并 ${sourceBranch} 到 ${targetBranch} 时发生冲突，请手动解决`);
        }

        // 推送到远程
        this.log(`⬆️ 推送 ${targetBranch} 分支...`);
        await this.execGitCommand(`git push origin ${targetBranch}:${targetBranch}`);
    }

    /**
     * 检查是否有合并冲突
     */
    private async checkMergeConflict(): Promise<boolean> {
        try {
            const { stdout } = await this.execGitCommand('git status --porcelain');
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
            () => this.autoMergeBranch()
        );

        const showBranchesCommand = vscode.commands.registerCommand(
            'extension.showBranches',
            () => this.showBranchInfo()
        );

        return [autoMergeCommand, showBranchesCommand];
    }

    /**
     * 显示分支信息
     */
    private async showBranchInfo(): Promise<void> {
        try {
            const currentBranch = await this.getCurrentBranch();
            const branches = await this.getAllBranches();
            
            this.outputChannel.show();
            this.log('📋 分支信息:');
            this.log(`当前分支: ${currentBranch}`);
            this.log('所有分支:');
            branches.forEach(branch => {
                this.log(`  - ${branch}${branch === currentBranch ? ' (当前)' : ''}`);
            });
        } catch (error) {
            this.logError('获取分支信息失败', error);
        }
    }

    /**
     * 释放资源
     */
    dispose(): void {
        this.outputChannel.dispose();
    }
}
