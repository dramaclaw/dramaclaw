# Linux/Docker Hermes 沙箱部署要求

本项目的 Hermes 子进程会使用 `codex-linux-sandbox`。Linux 沙箱可以限制写入目录和网络，
但当前 `workspace-write` 运行模型对挂载进程可见的根文件系统保持只读可见。因此，**容器
挂载整个共享 `/data` 时，不能把它当作跨租户读取隔离**。

## 默认镜像加固

API 镜像默认使用非 root 用户 `dramaclaw:10001`。Compose 配置还会启用：

- 只读容器根文件系统；
- `cap_drop: ALL`；
- `no-new-privileges`；
- 仅为临时文件提供 `tmpfs`；
- Hermes CLI 放在非 root 用户的 home 下。

已有命名卷如果是 root 创建的，升级后需要在停机窗口修正一次权限，或者迁移到新卷：

```bash
docker compose run --rm --user root api sh -lc \
  'chown -R 10001:10001 /data'
```

## EE/多租户要求

EE 多租户部署不能把所有租户的 `state/output/runtime` 作为同一个可读卷挂载给 Hermes。
应使用以下任一方式：

1. 每个租户/任务独立 Hermes 容器，并只挂载该租户目录；或
2. Kubernetes/容器运行时为每个 Hermes worker 提供只包含当前租户目录的 mount namespace。

共享资源（代码、内置技能、公共只读资产）可以单独只读挂载。禁止挂载 Docker Socket，
禁止 `privileged: true`，并为 Hermes/API 配置网络出口白名单。

如果部署环境无法提供按租户挂载隔离，不应将当前 Linux 沙箱宣传为完整的多租户文件读取隔离；
应用层项目权限校验和 Hermes 高风险工具禁用仍然必须保留。
