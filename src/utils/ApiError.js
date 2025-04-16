class ApiError extends Error {
    constructor(
        statusCode,
        message = "Something went wrong",
        error = null,
        stack = ""
    ) {
        super(message);
        this.statusCode = statusCode;
        this.message = message;
        this.error = error;
        this.success = false;

        if (stack) {
            this.stack = stack;
        } else if (error?.stack) {
            this.stack = this.error.stack;
        } else {
            Error.captureStackTrace(this, this.constructor);
        }
    }
}

export { ApiError };
