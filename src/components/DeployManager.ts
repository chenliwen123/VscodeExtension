import * as vscode from 'vscode';
import * as path from 'path';

/**
 * 部署状态枚举
 */
enum DeployStatus {
    PREPARE = 1,
    DOING = 2,
    DONE = 3,
    ERROR = 4,
    ABORT = 5,
    JUMP = 9
}

/**
 * 项目信息接口
 */
interface ProjectInfo {
    businessProjectId?: string;
    businessProjectName?: string;
    value?: string;
    label?: string;
    [key: string]: any; // 允许其他字段
}

/**
 * 部署信息接口
 */
interface DeployInfo {
    buildId: number;
    applicationName: string;
    status?: DeployStatus;
    creator?: string;
    startTime?: string;
    endTime?: string;
    stageList?: any[];
    loading?: boolean;
}

/**
 * API响应接口
 */
interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    message?: string;
    code?: string;
}

/**
 * 部署管理器
 * 通过API接口实现项目部署功能
 */
export class DeployManager {
    private outputChannel: vscode.OutputChannel;
    private deployList: DeployInfo[] = [];
    private checkTimer: NodeJS.Timeout | null = null;

    constructor() {
        this.outputChannel = vscode.window.createOutputChannel('Deploy Manager');
        this.loadConfig();
    }

    /**
     * 加载配置
     */
    private loadConfig(): void {
        // 配置加载逻辑，如果需要的话可以在这里添加
    }

    /**
     * 获取认证Token
     */
    private async getToken(): Promise<string | null> {
        // 从配置中获取token，或者提示用户输入
        const config = vscode.workspace.getConfiguration('chenliwen-dev-tools');
        let token = config.get<string>('authToken');

        if (!token) {
            token = await vscode.window.showInputBox({
                prompt: '请输入认证Token',
                password: true,
                placeHolder: 'Bearer token...'
            });

            if (token) {
                // 保存token到配置中
                await config.update('authToken', token, vscode.ConfigurationTarget.Global);
            }
        }

        return token || null;
    }

    /**
     * API地址替换
     */
    private replaceApi(api: string): string {
        const prefixMap: Record<string, string> = {
            '/api-dev': 'http://10.52.70.10:410',
            '/local-faw': 'http://10.52.70.10:510'
        };

        for (const prefix in prefixMap) {
            if (api.startsWith(prefix)) {
                return `${prefixMap[prefix]}${api}`;
            }
        }
        return api;
    }

    /**
     * HTTP请求工具
     */
    private async httpRequest<T = any>(url: string, options: {
        method: 'GET' | 'POST';
        body?: any;
        params?: Record<string, any>;
        timeout?: number;
    }): Promise<ApiResponse<T>> {
        try {
            const token = await this.getToken();
            if (!token) {
                throw new Error('未获取到token');
            }

            const fullUrl = this.replaceApi(url);
            const urlObj = new URL(fullUrl);

            // 添加查询参数
            if (options.params) {
                Object.keys(options.params).forEach(key => {
                    urlObj.searchParams.append(key, String(options.params![key]));
                });
            }

            // 设置超时
            const controller = new AbortController();
            const timeout = options.timeout || 120000; // 2分钟默认超时
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const fetchOptions: RequestInit = {
                method: options.method,
                headers: {
                    'Authorization': `Bearer eyJhbGciOiJIUzUxMiJ9.eyJzdWIiOiIxNDEwNzYyNjIxQHFxLmNvbSIsImNyZWF0ZWQiOjE3NTM0MDMxMzUzMjEsImlkbWlkIjpudWxsLCJleHAiOjE3NTQwMDc5MzUsInVwa2lkIjoiMTc2NDgxNzg2NDM4MzQyMjQ2NSJ9.ge_WMmPOrmgC5NsmyoQ-W4b2RIT2GHVZF5qDVqC2a6gWdtWmEuevlgGL7opNpQtKH3UxSL7brqz6F5NyKZQ8Yw`,
                    'Content-Type': 'application/json',
                },
                signal: controller.signal,
            };

            if (options.body) {
                fetchOptions.body = JSON.stringify(options.body);
            }

            try {
                const response = await fetch(urlObj.toString(), fetchOptions);
                // const response = await fetch('http://10.52.70.10:510/local-faw/api/project/business/searchProject', fetchOptions);

                if (response.status === 200) {
                    const data: any = await response.json();
                    return {
                        success: true,
                        data: data.data || data,
                        message: data.message,
                        code: data.code
                    };
                } else {
                    // 只有200才算作成功，其它都当作异常
                    throw new Error(`HTTP ${response.status}`);
                }
            } catch (error) {
                throw error;
            } finally {
                clearTimeout(timeoutId);
            }
        } catch (error) {
            this.logError('HTTP请求失败', error);
            return {
                success: false,
                message: error instanceof Error ? error.message : '请求失败'
            };
        }
    }

    /**
     * 搜索项目
     */
    private async searchProjects(keyword?: string): Promise<ProjectInfo[]> {
        try {
            this.log(`🔍 搜索项目，关键词: ${keyword || '全部'}`);

            const response = await this.httpRequest<{list: ProjectInfo[]}>('/local-faw/api/project/business/searchProject', {
                method: 'GET',
                params: {
                    type: 'project',
                    pageNum: 1,
                    pageSize: 100,
                    ...(keyword ? { keyword } : {})
                }
            });

            this.log(`📡 API响应: success=${response.success}`);
            if (response.data) {
                this.log(`📊 响应数据: ${JSON.stringify(response.data, null, 2)}`);
            }

            if (response.success && response.data?.list) {
                const projects = response.data.list.map((item: any) => {
                    this.log(`📊 原始项目数据: ${JSON.stringify(item)}`);
                    return {
                        ...item,
                        value: item.businessProjectName || item.name || '',
                        label: item.businessProjectName || item.name || '',
                        businessProjectName: item.businessProjectName || item.name || '',
                        businessProjectId: item.businessProjectId || item.id || ''
                    };
                });
                this.log(`✅ 找到 ${projects.length} 个项目`);
                projects.forEach((project, index) => {
                    this.log(`  项目${index + 1}: ${project.businessProjectName} (ID: ${project.businessProjectId})`);
                });
                return projects;
            } else {
                this.log(`❌ 搜索失败: ${response.message || '未知错误'}`);
                return [];
            }
        } catch (error) {
            this.logError('搜索项目失败', error);
            return [];
        }
    }

    /**
     * 根据项目ID获取应用代码
     */
    private async getApplicationCode(businessProjectId: string): Promise<string | null> {
        try {
            // 获取项目详情
            const projectResponse = await this.httpRequest('/local-faw/api/devCenter/api/project', {
                method: 'GET',
                params: {
                    businessProjectId,
                    pageNum: 1,
                    pageSize: 100,
                    filters: 'showDelete=false'
                }
            });

            if (!projectResponse.success || !projectResponse.data?.list?.[0]?.id) {
                return null;
            }

            const bizProjectId = projectResponse.data.list[0].id;

            // 获取应用信息
            const appResponse = await this.httpRequest(`/local-faw/api/devCenter/yq/project/${bizProjectId}`, {
                method: 'GET',
                params: {
                    bizProjectId,
                    relationType: 1
                }
            });

            if (appResponse.success && appResponse.data?.applicationClassifies) {
                const frontApp = appResponse.data.applicationClassifies
                    .find((item: any) => item.applicationClassify === 'front')
                    ?.applications?.[0];
                return frontApp?.nameEn || null;
            }
        } catch (error) {
            this.logError('获取应用代码失败', error);
        }
        return null;
    }

    /**
     * 启动部署流水线
     */
    private async startPipeline(applicationCode: string): Promise<boolean> {
        try {
            // 检查是否已在部署中
            if (this.deployList.find(item => item.applicationName === applicationCode)) {
                vscode.window.showWarningMessage('当前项目正在部署中，如需部署请先终止');
                return false;
            }

            const response = await this.httpRequest('/local-faw/api/buildService/api/app/build/startPipeline', {
                method: 'POST',
                body: {
                    applicationCode,
                    environmentType: 'daily'
                }
            });

            if (response.success && response.data?.buildId) {
                const deployInfo: DeployInfo = {
                    buildId: +response.data.buildId,
                    applicationName: applicationCode
                };
                this.deployList.push(deployInfo);
                this.startProgressCheck();
                return true;
            } else if (response.code === '409' && response.message) {
                // 处理已存在的构建
                const buildIdMatch = response.message.match(/(?<=id:\s)\d+/);
                if (buildIdMatch) {
                    const deployInfo: DeployInfo = {
                        buildId: +buildIdMatch[0],
                        applicationName: applicationCode
                    };
                    this.deployList.push(deployInfo);
                    this.startProgressCheck();
                    return true;
                }
            }

            vscode.window.showErrorMessage(`部署启动失败: ${response.message || '未知错误'}`);
            return false;
        } catch (error) {
            this.logError('启动部署失败', error);
            vscode.window.showErrorMessage('部署启动失败');
            return false;
        }
    }

    /**
     * 获取部署进度
     */
    private async fetchProgress(buildId: number): Promise<DeployStatus | null> {
        try {
            const response = await this.httpRequest('/local-faw/api/buildService/api/app/build/detail', {
                method: 'POST',
                body: { buildId }
            });

            if (response.success && response.data) {
                const data = response.data;

                // 更新部署列表
                this.deployList = this.deployList.map(item => {
                    if (item.buildId === data.buildId) {
                        // 检查是否完成，如果完成则显示通知
                        if (this.checkDone(data.status) && !this.checkDone(item.status)) {
                            this.showDeployNotification(data);
                        }
                        return { ...item, ...data };
                    }
                    return item;
                });

                return data.status;
            }
        } catch (error) {
            this.logError('获取部署进度失败', error);
        }
        return null;
    }

    /**
     * 检查状态是否已完成
     */
    private checkDone(status?: DeployStatus): boolean {
        return status ? [DeployStatus.DONE, DeployStatus.ERROR, DeployStatus.ABORT, DeployStatus.JUMP].includes(status) : false;
    }

    /**
     * 显示部署完成通知
     */
    private showDeployNotification(deployInfo: DeployInfo): void {
        const statusText = this.getStatusText(deployInfo.status);
        const message = `${deployInfo.applicationName} 部署完成: ${statusText}`;

        if (deployInfo.status === DeployStatus.DONE) {
            vscode.window.showInformationMessage(message);
        } else {
            vscode.window.showWarningMessage(message);
        }
    }

    /**
     * 获取状态文本
     */
    private getStatusText(status?: DeployStatus): string {
        const statusMap = {
            [DeployStatus.PREPARE]: '准备中',
            [DeployStatus.DOING]: '进行中',
            [DeployStatus.DONE]: '已完成',
            [DeployStatus.ERROR]: '失败',
            [DeployStatus.ABORT]: '已终止',
            [DeployStatus.JUMP]: '已跳过'
        };
        return status ? statusMap[status] || '未知' : '未知';
    }

    /**
     * 开始进度检查
     */
    private startProgressCheck(): void {
        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
        }
        this.checkProgressLoop();
    }

    /**
     * 进度检查循环
     */
    private async checkProgressLoop(): Promise<void> {
        try {
            const deployingList = this.deployList.filter(item =>
                [DeployStatus.PREPARE, DeployStatus.DOING].includes(item.status!) || !item.status
            );

            if (deployingList.length === 0) {
                return;
            }

            const statusList = await Promise.all(
                deployingList.map(item => this.fetchProgress(item.buildId))
            );

            // 如果还有未完成的部署，继续检查
            if (statusList.some(status => status && !this.checkDone(status))) {
                this.checkTimer = setTimeout(() => {
                    this.checkProgressLoop();
                }, 20000); // 20秒检查一次
            }
        } catch (error) {
            this.logError('检查部署进度失败', error);
        }
    }

    /**
     * 终止部署流水线
     */
    private async abortPipeline(buildId: number): Promise<boolean> {
        try {
            const deployInfo = this.deployList.find(item => item.buildId === buildId);
            if (!deployInfo) {
                vscode.window.showWarningMessage('未找到构建信息');
                return false;
            }

            // 设置加载状态
            this.deployList = this.deployList.map(item =>
                item.buildId === buildId ? { ...item, loading: true } : item
            );

            const response = await this.httpRequest('/local-faw/api/buildService/api/app/build/abortPipeline', {
                method: 'POST',
                body: {
                    buildId,
                    applicationCode: deployInfo.applicationName,
                    environmentType: 'daily'
                }
            });

            // 取消加载状态
            this.deployList = this.deployList.map(item =>
                item.buildId === buildId ? { ...item, loading: false } : item
            );

            if (response.success) {
                await this.fetchProgress(buildId);
                return true;
            } else {
                vscode.window.showErrorMessage(`终止部署失败: ${response.message || '未知错误'}`);
                return false;
            }
        } catch (error) {
            this.logError('终止部署失败', error);
            vscode.window.showErrorMessage('终止部署失败');
            return false;
        }
    }

    /**
     * 显示部署选项并执行
     */
    async showDeployOptions(): Promise<void> {
        try {
            this.outputChannel.show();
            this.log('🚀 开始部署流程...');

            // 搜索项目
            this.log('🔍 搜索可用项目...');
            const projects = await this.searchProjects();

            if (projects.length === 0) {
                vscode.window.showErrorMessage('未找到可用项目');
                return;
            }

            // 让用户选择项目
            interface ProjectQuickPickItem extends vscode.QuickPickItem {
                project: ProjectInfo;
            }

            const projectItems: ProjectQuickPickItem[] = projects.map((project: ProjectInfo,index:Number):any => {
                const label = project.businessProjectName || project.label || '未知项目';
                const description = project.businessProjectId || project.value || '';
                return {
                    label: label+''+index,
                    description: description+''+index,
                    detail: `项目ID: ${project.businessProjectId || 'N/A'}`,
                    project: project
                };
            });

            this.log(`📋 准备显示 ${projectItems.length} 个项目选项:`);
            projectItems.forEach((item, index) => {
                this.log(`  ${index + 1}. "${item.label}" (${item.description})`);
            });

            if (projectItems.length === 0) {
                vscode.window.showErrorMessage('没有找到可用的项目');
                return;
            }


            this.log('🎯 调用真实项目选择...');
            const selectedProject = await vscode.window.showQuickPick(projectItems, {
                placeHolder: '选择要部署的项目',
                title: 'SIT环境部署',
                matchOnDescription: true,
                matchOnDetail: true,
                canPickMany: false
            });

            this.log(`📝 用户选择结果: ${selectedProject ? selectedProject.label : '未选择'}`);

            if (!selectedProject) {
                this.log('❌ 用户取消选择');
                return;
            }

            if (!selectedProject) {
                return;
            }

            this.log(`📋 选择项目: ${selectedProject.label}`);

            // 获取应用代码
            this.log('🔍 获取应用代码...');
            const projectId = selectedProject.project.businessProjectId;
            if (!projectId) {
                vscode.window.showErrorMessage('项目ID不存在，无法获取应用代码');
                return;
            }

            const applicationCode = await this.getApplicationCode(projectId);

            if (!applicationCode) {
                vscode.window.showErrorMessage('未找到应用代码，请检查项目配置');
                return;
            }

            this.log(`📦 应用代码: ${applicationCode}`);

            // 确认部署
            const confirmResult = await vscode.window.showInformationMessage(
                `确定要部署 ${selectedProject.label} (${applicationCode}) 到SIT环境吗？`,
                { modal: true },
                '确定部署',
                '取消'
            );

            if (confirmResult !== '确定部署') {
                return;
            }

            // 启动部署
            this.log('🚀 启动部署流水线...');
            const success = await this.startPipeline(applicationCode);

            if (success) {
                this.log('✅ 部署已启动，正在监控进度...');
                vscode.window.showInformationMessage(`${selectedProject.label} 部署已启动`);
            }

        } catch (error) {
            this.logError('部署流程失败', error);
            vscode.window.showErrorMessage('部署流程失败');
        }
    }

    /**
     * 显示部署状态
     */
    async showDeployStatus(): Promise<void> {
        if (this.deployList.length === 0) {
            vscode.window.showInformationMessage('当前没有部署任务');
            return;
        }

        const statusItems = this.deployList.map(deploy => {
            const statusText = this.getStatusText(deploy.status);
            const isRunning = !this.checkDone(deploy.status);

            return {
                label: `${deploy.applicationName}`,
                description: `构建ID: ${deploy.buildId}`,
                detail: `状态: ${statusText} ${deploy.creator ? `| 创建者: ${deploy.creator}` : ''}`,
                deploy: deploy,
                isRunning: isRunning
            };
        });

        const selected = await vscode.window.showQuickPick(statusItems, {
            placeHolder: '选择部署任务进行操作',
            title: '部署状态管理'
        });

        if (selected) {
            await this.showDeployActions(selected.deploy);
        }
    }

    /**
     * 显示部署操作选项
     */
    private async showDeployActions(deploy: DeployInfo): Promise<void> {
        const actions: vscode.QuickPickItem[] = [];

        if (this.checkDone(deploy.status)) {
            actions.push({
                label: '$(trash) 移除任务',
                description: '从列表中移除此部署任务'
            });
        } else {
            actions.push({
                label: '$(stop-circle) 终止部署',
                description: '终止当前部署流水线'
            });
        }

        actions.push({
            label: '$(refresh) 刷新状态',
            description: '手动刷新部署状态'
        });

        const selected = await vscode.window.showQuickPick(actions, {
            placeHolder: `选择对 ${deploy.applicationName} 的操作`,
            title: '部署操作'
        });

        if (!selected) {
            return;
        }

        if (selected.label.includes('移除任务')) {
            this.deployList = this.deployList.filter(item => item.buildId !== deploy.buildId);
            vscode.window.showInformationMessage('任务已移除');
        } else if (selected.label.includes('终止部署')) {
            const confirmed = await vscode.window.showWarningMessage(
                `确定要终止 ${deploy.applicationName} 的部署吗？`,
                { modal: true },
                '确定终止',
                '取消'
            );
            if (confirmed === '确定终止') {
                await this.abortPipeline(deploy.buildId);
            }
        } else if (selected.label.includes('刷新状态')) {
            await this.fetchProgress(deploy.buildId);
            vscode.window.showInformationMessage('状态已刷新');
        }
    }

    /**
     * 注册VSCode命令
     */
    registerCommands(): vscode.Disposable[] {
        const deployCommand = vscode.commands.registerCommand(
            'extension.deploy',
            () => this.showDeployOptions()
        );

        const statusCommand = vscode.commands.registerCommand(
            'extension.deployStatus',
            () => this.showDeployStatus()
        );

        return [deployCommand, statusCommand];
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
        this.outputChannel.appendLine(`[${timestamp}] ❌ ${message}`);
        if (error) {
            this.outputChannel.appendLine(`[${timestamp}] 错误详情: ${error.message || error}`);
        }
    }

    /**
     * 清理资源
     */
    dispose(): void {
        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
            this.checkTimer = null;
        }
        this.outputChannel.dispose();
    }
}
