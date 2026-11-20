/**
 * Preset close-reading session for "Deep Residual Learning" (arXiv 1512.03385).
 * Chips quote the bundled page text verbatim so jump + highlight both work.
 */
import { cite } from "./cite.ts";

const md = String.raw;

export const resnetPreset = {
  itemKey: "1512.03385",
  title: "ResNet 精读：深度为什么不再有害",
  conclusion: md`- **问题**：加深网络后训练误差反而升高，且不是过拟合（p.1，Fig.1）
- **做法**：把要学的映射改写成残差 $F(x)=H(x)-x$，块输出 $y=F(x,\{W_i\})+x$；恒等捷径零参数、零额外计算（p.3）
- **实现**：维度变化处才用 $1\times1$ 投影；深层用 1×1→3×3→1×1 的 bottleneck（p.3、p.6）
- **结果**：同参数量下 plain-34 28.54 → ResNet-34 25.03 top-1；152 层单模型 top-5 4.49%，集成 3.57%（p.5–7）
- **证据链**：1202 层也能把训练误差压到 <0.1%，但测试变差 → 瓶颈从「优化」转移到「正则」（p.8）`,
  turns: [
    {
      q: "这篇论文的核心创新点是什么？为什么「加深反而变差」这件事值得专门写一篇？",
      a: md`## 一、起点是一个反直觉的实验现象

56 层「plain」网络在 CIFAR-10 上比 20 层更差，而且**训练误差也更高**：${cite(1, "The deeper network has higher training error, and thus test error")}
作者特别强调这不是过拟合：${cite(1, "Unexpectedly, such degradation is not caused by overfitting, and adding more layers to a suitably deep model leads to higher")}

这一点很关键：如果加深只是让模型更容易过拟合，那属于「容量 vs 数据」的老问题；而训练误差同步上升说明是**优化失败**。

## 二、一个「存在性论证」把矛头指向优化器

给定浅层模型，深层模型总可以这样构造：新增层做成恒等映射、其余层照抄浅层权重——这样深层的解空间包含浅层的解，训练误差不该更高：${cite(1, "the added layers are identity mapping, and the other layers are copied from the learned shallower model")}
但实验里求解器就是找不到这种解：${cite(1, "But experiments show that our current solvers on hand are unable to find solutions that")}

> 于是全文的问题定义被压缩成一句：**不是要学更强的映射，而是要让「什么都不改」变成一个容易到达的解。**

## 三、核心做法：残差学习

$$H(x)\;\longrightarrow\;F(x)+x,\qquad F(x):=H(x)-x$$

${cite(3, "rather than expect stacked layers to approximate H(x), we explicitly let these layers approximate a residual function")}
直觉解释：如果最优解接近恒等，把多层非线性权重推向 0，比用它们去拟合恒等映射容易得多：${cite(3, "if identity mappings are optimal, the solvers may simply drive the weights of the multiple nonlinear")}
即使恒等并非最优，残差写法也能起到**预条件**作用：${cite(3, "our reformulation may help to precondition the problem")}

## 四、实现：捷径连接（几乎免费）

$$y=F(x,\{W_i\})+x \tag{1}$$

${cite(3, "The operation F + x is performed by a shortcut connection and element-wise addition")}
维度相等时直接用恒等；不等时加一个线性投影：${cite(3, "we can perform a linear projection Ws by the shortcut connections to match the dimensions")}

$$y=F(x,\{W_i\})+W_sx \tag{2}$$

最能支撑「公平对比」的一句话——恒等捷径不引入参数也不引入计算：${cite(2, "connections add neither extra parameter nor")}
这意味着 plain / residual 可以在同深度、同宽度、同参数量的条件下逐条对照（Table 2 就是这么做的）。

## 五、30 秒记忆点

ResNet 的贡献不是「把网络堆得更深」，而是**改写学习目标的形式**，让深度从「天然有害」变成「天然无害」；后面的 Highway、Transformer 的 $x+\mathrm{Sublayer}(x)$、BERT 的残差子层，都直接继承了这条写法。`,
    },
    {
      q: "具体讲清结构设计和训练配方：plain 网络的构造规则、bottleneck 的参数账、以及为什么不是梯度消失。",
      a: md`## 1. plain 34 的构造规则（理解 ResNet 的前提）

卷积基本都是 $3\times3$，遵守两条规则：${cite(3, "The convolutional layers mostly have 3×3 filters and follow two simple design rules")}
- 同尺寸特征图 → 通道数不变；
- 特征图尺寸减半 → 通道数翻倍，以保持每层计算量不变。

下采样不靠 pooling，而是靠 stride 2 的卷积：${cite(3, "We perform downsampling directly by convolutional layers that have a stride of 2")}
计算量对比是这个架构常被忽略的优势：${cite(3, "has 3.6 billion FLOPs (multiply-adds), which is only 18% of VGG-19")}

## 2. 残差块的两种形式与一条负面结论

恒等：$y=F(x,\{W_i\})+x$；投影：$y=F(x,\{W_i\})+W_sx$。
使用条件写得很清楚：${cite(3, "The dimensions of x and F must be equal in Eqn.(1)")}
负面结论同样重要——只有一层的残差等价于线性层，没有收益：${cite(3, "Eqn.(1) is similar to a linear layer")}
> 换言之：残差的价值来自「多层非线性 + 恒等参照」的组合，而不是加法本身。

三个捷径选项（A 零填充 / B 只在升维处投影 / C 全部投影）的实验结论：${cite(6, "projection shortcuts are not essential for addressing the degradation problem")}
所以默认用 B，并且恒等捷径对 bottleneck 架构的成本控制尤其关键：${cite(6, "Identity shortcuts are particularly important for not increasing the complexity of the bottleneck architectures")}

## 3. bottleneck 的参数账

$$y=W^{(3)}\,\sigma\!\big(W^{(2)}\sigma(W^{(1)}x)\big)+x$$

其中 $W^{(1)}:1\times1$ 降维、$W^{(2)}:3\times3$、$W^{(3)}:1\times1$ 升维：${cite(6, "we modify the building block as a bottleneck design")}
${cite(6, "The three layers are 1×1, 3×3, and 1×1 convolutions, where the 1×1 layers are responsible for reducing and then increasing")}

设计动机写得很坦率：受可承受的训练时间约束。代价是 $3\times3$ 只作用在被压缩后的通道上，于是 50/101/152 层变得可行：${cite(7, "resulting in a 50-layer ResNet")}
152 层的复杂度依然低于 VGG-16/19：${cite(7, "the 152-layer ResNet (11.3 billion FLOPs) still has lower complexity than VGG-16/19 nets")}

## 4. 训练配方（复现清单）

ImageNet：${cite(4, "We use SGD with a mini-batch size of 256.")}，学习率${cite(4, "The learning rate starts from 0.1 and is divided by 10 when the error plateaus")}
权重衰减 0.0001、momentum 0.9，并且**不用 dropout**：${cite(4, "We do not use dropout")}
BN 位置固定在每个卷积之后、激活之前：${cite(4, "We adopt batch normalization (BN) [16] right after each convolution and before activation")}
数据增强：短边在 [256, 480] 随机缩放 + $224\times224$ 随机裁剪 + 标准颜色增强：${cite(4, "The image is resized with its shorter side ran")}
测试用 10-crop；追求最佳结果时改成全卷积形式并在多尺度平均：${cite(4, "average the scores at multiple scales")}

CIFAR-10 的极简配置（便于自己复现）：${cite(7, "The network inputs are 32×32 images, with the per-pixel mean subtracted")}，堆叠 $6n$ 层、特征图尺寸 {32,16,8}，对应通道数 16/32/64（${cite(7, "The numbers of filters are {16, 32, 64} respectively")}）

## 5. 为什么不是梯度消失

作者排除了这个解释，理由是与 BN 配套的测量：${cite(5, "These plain networks are trained with BN")}
${cite(5, "We also verify that the backward propagated gradients exhibit healthy norms with BN")}
他们给出的猜测是收敛速率问题：${cite(5, "We conjecture that the deep plain nets may have exponentially low convergence rates")}
这条推测后来被大量工作（初始化、Pre-activation、归一化位置）继续追问——但 ResNet 本身只用「层响应统计」给了一个可测的证据，见第 3 轮。`,
    },
    {
      q: "结果、分析和局限分别是什么？哪些数字是必须记住的？",
      a: md`## 1. ImageNet：更深更好的直接证据

同参数量对比（Table 2，p.5）：plain-34 的 top-1 是 28.54%，ResNet-34 是 25.03%。反例先出现：${cite(4, "the deeper 34-layer plain net has higher validation error than the shallower 18-layer plain net")}
换成残差后关系反转：${cite(5, "the 34-layer ResNet is better than the 18-layer ResNet")}
并且这种提升不是靠加参数买来的——论文特意强调 ${cite(5, "the residual networks have no extra parameter compared to their plain counterparts")}

阶梯式结果（Table 3/4，p.6）：ResNet-50 22.85 → ResNet-101 21.75 → ResNet-152 21.43 top-1（验证集，10-crop）。
单模型就能压过以往的集成：${cite(7, "This single-model result outperforms all previous ensemble results")}
集成最终成绩：${cite(2, "Our ensemble has 3.57% top-5 error on the ImageNet test set")}

还有一个「便宜的胜利」：18 层 plain 与 18 层 ResNet 精度相当，但 ResNet 收敛更快——说明在不算深的网络里，残差的主要收益是**优化速度**：${cite(6, "the 18-layer ResNet converges faster")}

## 2. CIFAR-10：1000+ 层能不能训

${cite(8, "We set n = 200 that leads to a 1202-layer network")}
训练侧完全没有障碍：${cite(8, "this 103-layer network is able to achieve training error")}
但测试成绩不如 110 层，作者归因于过拟合与缺少强正则：${cite(8, "We argue that this is because of overfitting")}
> 这条对比很重要：它说明 ResNet 把瓶颈从「优化困难」换成了「正则化/数据规模」，问题没消失，只是转移了。

## 3. 层响应分析：残差确实很小

${cite(8, "Fig. 7 shows that ResNets have generally smaller responses than their plain counterparts")}
层越多，单层对信号的改动越小：${cite(8, "an individual layer of ResNets tends to modify the signal less")}
这是对第 1 轮「恒等是好的预条件」假设的直接测量证据（Fig.7 统计的是每个 $3\times3$ 层在 BN 之后、其他非线性之前的输出标准差）。

## 4. 迁移性：换 backbone 就涨点

${cite(8, "Our method has good generalization performance on other recognition tasks")}
PASCAL VOC / COCO 上，Faster R-CNN 只把 VGG-16 换成 ResNet-101 就有明显 mAP 提升（Table 7/8，p.8：COCO val 41.5 → 48.4 mAP@.5）。
配合极深表示，作者拿下 ILSVRC & COCO 2015 的四项第一：${cite(1, "we also won the 1st places on the tasks of ImageNet detection, ImageNet local")}

## 5. 局限与后续方向

1. **机制仍未解释**：为什么 plain 网络收敛率会指数级偏低，作者明确留作未来工作；在 1000+ 层上问题同样没有闭环：${cite(8, "there are still open problems on such aggressively deep models")}
2. **恒等捷径的前提是维度匹配**：跨维度仍需零填充或投影，而零填充的那些维度「其实没有做残差学习」——这是 option A 略逊于 B 的解释：${cite(6, "the zero-padded dimensions in A indeed have no residual learning")}
3. **可训练性依赖 BN 等配套**：论文的对比全部在 BN 前提下进行；去掉 BN 后残差的收益会被归一化/初始化问题混淆。
4. **延伸讨论（非原文）**：Pre-activation（ResNet v2）把加法与 ReLU 的顺序改掉，使恒等路径更「干净」；Highway / GRU 的门控可视为把恒等写成可学习系数；Transformer 与 BERT 里的 $x+\mathrm{Sublayer}(x)$ 则是同一写法在序列模型上的复用——这三篇在本工作台里可以对照着读。`,
    },
  ],
};
