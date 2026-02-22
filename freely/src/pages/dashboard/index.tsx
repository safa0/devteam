import { PluelyApiSetup } from "./components";
import { PageLayout } from "@/layouts";

const Dashboard = () => {
  return (
    <PageLayout
      title="Dashboard"
      description="Configure your AI providers and settings."
    >
      {/* Freely API Setup */}
      <PluelyApiSetup />
    </PageLayout>
  );
};

export default Dashboard;
