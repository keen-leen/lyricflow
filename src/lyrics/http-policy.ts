export function shouldRetryHttpStatus(status: number): boolean {
    return status === 429 || status >= 500;
}
