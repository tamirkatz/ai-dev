import express from "express";
import indexRoutes from "./routes/index.ts";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();

app.use(express.json());
app.use(cors());

// Routes
app.use("/", indexRoutes);

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server is listening on port ${PORT}`);
  try {
    // await connectIB();
  } catch (err) {
    console.error("❌ Failed to connect to Interactive Brokers:", err);
  }
});
