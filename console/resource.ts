/** 管理页面请求的加载、失败与过期响应，切换查询时不展示旧数据。 */
import { useEffect, useState } from "preact/hooks";

export function useAsync<Result>(
    load: () => Promise<Result>,
    dependencies: readonly unknown[],
) {
    const key = JSON.stringify(dependencies);
    const [state, setState] = useState<{
        key: string;
        value?: Result;
        error?: string;
        loading: boolean;
        updatedAt?: string;
    }>({ key, loading: true });
    useEffect(() => {
        let current = true;
        setState({ key, loading: true });
        load().then(
            (value) =>
                current &&
                setState({
                    key,
                    value,
                    loading: false,
                    updatedAt: new Date().toISOString(),
                }),
            () =>
                current &&
                setState({
                    key,
                    error: "读取失败，请检查连接与登录状态后重试。",
                    loading: false,
                }),
        );
        return () => {
            current = false;
        };
    }, [key]);
    return state.key === key ? state : { key, loading: true };
}
