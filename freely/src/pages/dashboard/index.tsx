import { Usage } from "./components";
import { PageLayout } from "@/layouts";

const Dashboard = () => {
  return (
    <PageLayout
      title="Dashboard"
      description="Configure your AI providers and settings."
    >
      <Usage
        loading={false}
        onRefresh={() => {}}
        data={[]}
        totalTokens={0}
      />
    </PageLayout>
  );
};

export default Dashboard;
