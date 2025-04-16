class ApiResponse {
    constructor(statusCode, data, message = "Success", metadata = {}) {
        this.statusCode = statusCode;
        this.data = data;
        this.message = message;
        this.success = statusCode < 400;
        this.metadata = metadata;
    }
}

export { ApiResponse };
