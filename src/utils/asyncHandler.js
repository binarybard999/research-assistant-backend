const asyncHandler = (requestHandler) => {
    return async (req, res, next) => {
        try {
            await requestHandler(req, res, next);
        } catch (err) {
            console.error(`AsyncHandler Error: ${err.message}`, {
                path: req.path,
                method: req.method,
                params: req.params,
                body: req.body,
            });
            next(err);
        }
    };
};

export default asyncHandler;
