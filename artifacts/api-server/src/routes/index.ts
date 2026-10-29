import { Router, type IRouter } from "express";
import healthRouter from "./health";
import forecastRouter from "./forecast";
import researchRouter from "./research";
import historicalCorpusRouter from "./historical-corpus";

const router: IRouter = Router();

router.use(healthRouter);
router.use(forecastRouter);
router.use(researchRouter);
router.use(historicalCorpusRouter);

export default router;
