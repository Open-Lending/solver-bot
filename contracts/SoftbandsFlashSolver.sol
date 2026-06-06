// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.0;

interface IERC20FlashSolver {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAaveFlashLoanSimplePool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface ISoftbandsPoolFlashExecutor {
    function collateralToken() external view returns (address);
    function debtToken() external view returns (address);
    function fill(uint256 maxCollateralOut, uint160 maxSqrtPriceX96)
        external
        returns (uint256 collateralOut, uint256 debtIn);
    function fillUp(uint256 maxDebtOut, uint160 minSqrtPriceX96)
        external
        returns (uint256 debtOut, uint256 collateralIn);
}

interface IUniswapV3PoolFlashExecutor {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

contract SoftbandsFlashSolver {
    enum Direction {
        FillDown,
        FillUp
    }

    struct ExecuteParams {
        address softbandsPool;
        address collateral;
        address debt;
        address uniswapPool;
        uint256 flashAmount;
        uint256 maxFillAmount;
        uint160 softbandsSqrtLimitX96;
        uint160 swapSqrtLimitX96;
        uint256 minProfit;
        address profitRecipient;
    }

    struct CallbackParams {
        Direction direction;
        ExecuteParams exec;
    }

    struct SwapCallbackData {
        address pool;
        address inputToken;
    }

    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE =
        1461446703485210103287273052203988822378723970341;

    IAaveFlashLoanSimplePool public immutable aavePool;
    address public owner;
    uint256 public lastProfit;
    address public lastProfitAsset;

    bool private flashInProgress;
    address private activeSwapPool;
    address private activeSwapInputToken;

    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event FlashFillExecuted(
        Direction indexed direction,
        address indexed softbandsPool,
        address indexed profitRecipient,
        address flashAsset,
        uint256 flashAmount,
        uint256 flashPremium,
        uint256 collateralOut,
        uint256 debtIn,
        uint256 debtOut,
        uint256 collateralIn,
        uint256 swapAmountOut,
        address profitAsset,
        uint256 profit
    );

    error NotOwner();
    error InvalidAddress();
    error InvalidCallback();
    error InvalidTokens();
    error InvalidDirection();
    error InsufficientProfit();
    error SwapSlippage();
    error TransferFailed();
    error ReentrantFlash();
    error FlashAmountMismatch();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _aavePool, address _owner) {
        if (_aavePool == address(0) || _owner == address(0)) revert InvalidAddress();
        aavePool = IAaveFlashLoanSimplePool(_aavePool);
        owner = _owner;
        emit OwnershipTransferred(address(0), _owner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function executeFillDown(ExecuteParams calldata p) external onlyOwner returns (uint256 profit) {
        profit = _execute(Direction.FillDown, p);
    }

    function executeFillUp(ExecuteParams calldata p) external onlyOwner returns (uint256 profit) {
        profit = _execute(Direction.FillUp, p);
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(aavePool) || initiator != address(this) || !flashInProgress) {
            revert InvalidCallback();
        }

        CallbackParams memory cb = abi.decode(params, (CallbackParams));
        ExecuteParams memory p = cb.exec;
        address expectedAsset = cb.direction == Direction.FillDown ? p.debt : p.collateral;
        if (asset != expectedAsset) revert InvalidTokens();
        if (amount != p.flashAmount) revert FlashAmountMismatch();

        _validateParams(p);

        uint256 repayAmount = amount + premium;
        uint256 collateralOut;
        uint256 debtIn;
        uint256 debtOut;
        uint256 collateralIn;
        uint256 swapAmountOut;
        address profitAsset = asset;
        address recipient = p.profitRecipient == address(0) ? owner : p.profitRecipient;

        if (cb.direction == Direction.FillDown) {
            _forceApprove(p.debt, p.softbandsPool, amount);
            (collateralOut, debtIn) = ISoftbandsPoolFlashExecutor(p.softbandsPool).fill(
                p.maxFillAmount,
                p.softbandsSqrtLimitX96
            );
            if (debtIn > amount) revert FlashAmountMismatch();

            uint256 debtBalanceBeforeSwap = IERC20FlashSolver(p.debt).balanceOf(address(this));
            uint256 minSwapOut = _shortfallPlusMinProfit(debtBalanceBeforeSwap, repayAmount, p.minProfit);
            if (collateralOut > 0) {
                swapAmountOut = _swapExactInput(
                    p.uniswapPool,
                    p.collateral,
                    p.debt,
                    collateralOut,
                    minSwapOut,
                    p.swapSqrtLimitX96
                );
            }
        } else if (cb.direction == Direction.FillUp) {
            _forceApprove(p.collateral, p.softbandsPool, amount);
            (debtOut, collateralIn) = ISoftbandsPoolFlashExecutor(p.softbandsPool).fillUp(
                p.maxFillAmount,
                p.softbandsSqrtLimitX96
            );
            if (collateralIn > amount) revert FlashAmountMismatch();

            uint256 collateralBalanceBeforeSwap = IERC20FlashSolver(p.collateral).balanceOf(address(this));
            uint256 minSwapOut = _shortfallPlusMinProfit(collateralBalanceBeforeSwap, repayAmount, p.minProfit);
            if (debtOut > 0) {
                swapAmountOut = _swapExactInput(
                    p.uniswapPool,
                    p.debt,
                    p.collateral,
                    debtOut,
                    minSwapOut,
                    p.swapSqrtLimitX96
                );
            }
        } else {
            revert InvalidDirection();
        }

        uint256 balance = IERC20FlashSolver(asset).balanceOf(address(this));
        if (balance < repayAmount + p.minProfit) revert InsufficientProfit();

        uint256 profit = balance - repayAmount;
        lastProfit = profit;
        lastProfitAsset = profitAsset;

        if (profit > 0) {
            _safeTransfer(asset, recipient, profit);
        }
        _forceApprove(asset, address(aavePool), repayAmount);

        emit FlashFillExecuted(
            cb.direction,
            p.softbandsPool,
            recipient,
            asset,
            amount,
            premium,
            collateralOut,
            debtIn,
            debtOut,
            collateralIn,
            swapAmountOut,
            profitAsset,
            profit
        );

        return true;
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        SwapCallbackData memory cb = abi.decode(data, (SwapCallbackData));
        if (
            msg.sender != cb.pool ||
            msg.sender != activeSwapPool ||
            cb.inputToken != activeSwapInputToken
        ) revert InvalidCallback();

        uint256 amountToPay;
        if (amount0Delta > 0) {
            amountToPay = uint256(amount0Delta);
        } else if (amount1Delta > 0) {
            amountToPay = uint256(amount1Delta);
        } else {
            revert InvalidCallback();
        }

        _safeTransfer(cb.inputToken, cb.pool, amountToPay);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        _safeTransfer(token, to, amount);
    }

    function _execute(Direction direction, ExecuteParams calldata p) internal returns (uint256 profit) {
        if (flashInProgress) revert ReentrantFlash();
        _validateParams(p);

        address asset = direction == Direction.FillDown ? p.debt : p.collateral;
        lastProfit = 0;
        lastProfitAsset = asset;

        flashInProgress = true;
        aavePool.flashLoanSimple(
            address(this),
            asset,
            p.flashAmount,
            abi.encode(CallbackParams({direction: direction, exec: p})),
            0
        );
        flashInProgress = false;

        return lastProfit;
    }

    function _validateParams(ExecuteParams memory p) internal view {
        if (
            p.softbandsPool == address(0) ||
            p.collateral == address(0) ||
            p.debt == address(0) ||
            p.uniswapPool == address(0) ||
            p.flashAmount == 0
        ) revert InvalidAddress();

        ISoftbandsPoolFlashExecutor softbands = ISoftbandsPoolFlashExecutor(p.softbandsPool);
        if (softbands.collateralToken() != p.collateral || softbands.debtToken() != p.debt) {
            revert InvalidTokens();
        }

        IUniswapV3PoolFlashExecutor uni = IUniswapV3PoolFlashExecutor(p.uniswapPool);
        address token0 = uni.token0();
        address token1 = uni.token1();
        bool matches = (token0 == p.collateral && token1 == p.debt) ||
            (token0 == p.debt && token1 == p.collateral);
        if (!matches) revert InvalidTokens();
    }

    function _swapExactInput(
        address pool,
        address inputToken,
        address outputToken,
        uint256 amountIn,
        uint256 minAmountOut,
        uint160 sqrtPriceLimitX96
    ) internal returns (uint256 amountOut) {
        IUniswapV3PoolFlashExecutor uni = IUniswapV3PoolFlashExecutor(pool);
        address token0 = uni.token0();
        address token1 = uni.token1();

        bool zeroForOne;
        if (inputToken == token0 && outputToken == token1) {
            zeroForOne = true;
        } else if (inputToken == token1 && outputToken == token0) {
            zeroForOne = false;
        } else {
            revert InvalidTokens();
        }

        uint160 limit = sqrtPriceLimitX96;
        if (limit == 0) {
            limit = zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE;
        }

        activeSwapPool = pool;
        activeSwapInputToken = inputToken;
        (int256 amount0, int256 amount1) = uni.swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            limit,
            abi.encode(SwapCallbackData({pool: pool, inputToken: inputToken}))
        );
        activeSwapPool = address(0);
        activeSwapInputToken = address(0);

        if (zeroForOne) {
            if (amount1 >= 0) revert SwapSlippage();
            amountOut = uint256(-amount1);
        } else {
            if (amount0 >= 0) revert SwapSlippage();
            amountOut = uint256(-amount0);
        }
        if (amountOut < minAmountOut) revert SwapSlippage();
    }

    function _shortfallPlusMinProfit(
        uint256 currentBalance,
        uint256 repayAmount,
        uint256 minProfit
    ) internal pure returns (uint256) {
        uint256 required = repayAmount + minProfit;
        return currentBalance >= required ? 0 : required - currentBalance;
    }

    function _forceApprove(address token, address spender, uint256 amount) internal {
        bytes memory approveCall = abi.encodeWithSelector(IERC20FlashSolver.approve.selector, spender, amount);
        if (_callOptionalReturnBool(token, approveCall)) return;

        require(_callOptionalReturnBool(
            token,
            abi.encodeWithSelector(IERC20FlashSolver.approve.selector, spender, 0)
        ));
        require(_callOptionalReturnBool(token, approveCall));
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        bytes memory transferCall = abi.encodeWithSelector(IERC20FlashSolver.transfer.selector, to, amount);
        (bool success, bytes memory returndata) = token.call(transferCall);
        if (!success) revert TransferFailed();
        if (returndata.length > 0 && !abi.decode(returndata, (bool))) revert TransferFailed();
    }

    function _callOptionalReturnBool(address token, bytes memory data) internal returns (bool) {
        (bool success, bytes memory returndata) = token.call(data);
        if (!success) return false;
        if (returndata.length == 0) return true;
        if (returndata.length < 32) return false;
        return abi.decode(returndata, (bool));
    }
}
